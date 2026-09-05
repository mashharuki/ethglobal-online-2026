# AI Agent 層の契約（MCP Server tools）

**v1.6・新設**：`docs/idea.md` v1.6 追記「AI Agent の実行基盤を MCP サーバーへ変更」に基づく。

**実装**: `apps/gateway/src/mcp/`（`@modelcontextprotocol/sdk`）。**gateway と同一 Cloudflare Workers 上に相乗り**し、`apps/gateway/src/routes/mcp.ts` が `/mcp` に Streamable HTTP transport をマウントする。**Base URL**: `https://gateway.<demo-host>.workers.dev/mcp`。

**接続方法（デモ）**: Claude Code / Codex 等の MCP 対応クライアントから、上記 URL を remote MCP server として追加する（例: `claude mcp add --transport http rights-runtime https://gateway.<demo-host>.workers.dev/mcp`）。認証なし（デモ用途、§9.1 信頼モデル参照）。

このファイルが定義する3ツールが「AI Agent」から見た唯一のインターフェースである。**発見〜復号までを行い、復号後データセットへの分析（自然言語での質問への回答）はツール化しない**——接続元のAIクライアント自身の推論に委ねる（FR-026）。

エラーは MCP のツール実行エラーとして返す。`code` は [error-codes.md](./error-codes.md) の `ErrorCode` と一致させる。

---

## `discover_assets`

利用可能な資産の一覧を返す（`gateway-api.md` の `GET /assets` を MCPツールとしてラップ。認可不要、FR-019・FR-020）。

**Input**: なし（将来的なフィルタ引数は stretch）

**Output**:
```json
[ { "assetId": "0x…", "tokenId": "1", "nftContract": "0x…",
    "previewURI": "ipfs://…", "manifestURI": "ipfs://…",
    "paidAccess": { "price": "100000", "durationSec": 300, "maxUses": 5 },
    "transferMode": "SURVIVE_TRANSFER",
    "permissions": { "commercial": true, "aiTraining": false, "derivative": true } } ]
```

Rights Graph（subgraph）経由の発見であり、**この結果を `buy_access` / `decrypt_content` の認可判定根拠として使ってはならない**（FR-020、憲章 II）——各ツールは呼び出しの都度オンチェーンを直読みする。

---

## `buy_access`

対象資産の有料アクセス権を x402 で購入する（User Story 2 / FR-004〜009）。MCP Server が保持する資金付き EOA（Workers Secrets Store）が支払人になる。

**Input**:
```json
{ "assetId": "0x…" }
```

**サーバ処理**（`gateway-api.md` の `POST /assets/:assetId/paid` フローを内部で実行）
1. `GET /assets/:assetId/paid` 相当で価格・条件を取得
2. `purchaseRequestHash` を計算し、`mcp/wallet.ts` の Privy server wallet（session signer）で x402「exact」（ネイティブ HBAR）の認可署名を作成
3. `x402/facilitator.ts`（Blocky402）経由で `RightsRegistry.settleAndIssue{value: price}` を submit（1 Hedera tx：HBAR 受領 → `RevenueAllocation` → `ReceiptIssued`。primary 不成立時は `payFor` + `finalize`）
4. tx 確定後、`receipt/issue.ts` が EIP-712 Receipt にサーバ署名
5. `audit_log`（`action='x402_settle'`、呼び出し元を `mcp-agent` として記録）

**Output**:
```json
{ "receiptHash": "0x…", "receipt": { "…17フィールド…" }, "serverSignature": "0x…",
  "onchainTx": "0x…", "maxUses": 5, "expiresAt": 1780000300 }
```

**エラー**: `UNDERPAYMENT` / `PAYMENT_ID_PAYLOAD_CONFLICT` / `RESOURCE_HASH_MISMATCH` / `POLICY_HASH_MISMATCH`（[error-codes.md](./error-codes.md) #3・#4・#9・#10）。資金付き EOA の残高不足はツール実行エラー `INSUFFICIENT_AGENT_BALANCE`（補助コード、デモ運用上の制約）として返す。

---

## `decrypt_content`

`buy_access` で取得した `receiptHash` を使って対象資産を復号し、平文（データセット本体）を返す（KeyGate 購入者パス、FR-015 / FR-016）。

**Input**:
```json
{ "assetId": "0x…", "receiptHash": "0x…" }
```

**サーバ処理**（`gateway-api.md` の `POST /keygate/share`（licensee パス）と同一の三層原子制御・R-3 を内部で実行）
1. `mcp/wallet.ts` の秘密鍵で `KeyGateChallenge{assetId, purpose:"licensee", receiptHash}` に署名
2. `ReceiptLock` Durable Object 内で `receiptStatus` 直読み・`useIndex` 採番・`RightsRegistry.consume` submit・`share_G` 放出（settle-before-release、憲章 V）
3. `share_U` を導出し `K = share_G XOR share_U` を復元、暗号化コンテンツを取得して **MCP Server プロセス内で** `AES-256-GCM` 復号する（このツールに関しては MCP Server 自身が「クライアント」としての役割を担う。§9.1 参照。Access Gateway 自体は `K`・平文を扱わないという不変条件は変わらない）
4. 復号済みデータセットをツールの戻り値として返す

**Output**:
```json
{ "useIndex": 3, "onchainTx": "0x…",
  "dataset": { "format": "csv", "content": "region,segment,mrr_usd,churn_pct\n…" } }
```

**エラー**: `LICENSEE_MISMATCH` / `RECEIPT_EXPIRED` / `USE_LIMIT_EXCEEDED` / `RECEIPT_ALREADY_CONSUMED` / `LICENSE_INVALIDATED_ON_TRANSFER` / `LICENSE_EPOCH_MISMATCH`（[error-codes.md](./error-codes.md) #1・#2・#6・#7・#8・#13・#14）。

---

## 信頼モデル・スコープ注記

- MCP Server は資金付き EOA の秘密鍵を保持し、`buy_access` / `decrypt_content` を代行実行する。**URL に到達できる任意の MCP クライアントがこのウォレットから支出できる**（デモ用の残高制限・レート制限で許容。`docs/idea.md` §9.1 信頼モデル・§19 リスク）。
- `analyze`（データセットへの分析質問への回答）はツール化しない。SC-007 / SC-009 の人手0自動検証は、CI 専用の `apps/agent/` ハーネス（`apps/agent/src/mcpClient.ts` が本ツール群を呼び、`apps/agent/src/analyze.ts` が Claude tool-use で分析する）で担保する（`research.md` 参照）。
- 認証・レート制限は本 MVP では簡略化（デモ用途）。本番運用では MCP クライアントごとの API キー発行・ウォレット分離が必要（非ゴール）。
