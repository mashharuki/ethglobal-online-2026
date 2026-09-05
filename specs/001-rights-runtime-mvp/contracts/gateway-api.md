# Backend 層の契約（Access Gateway HTTP API）

**機械可読な単一の真実源は `packages/openapi/openapi.yaml`（OpenAPI 3.1）**。本ファイルはその人間向けの解説であり、内容が食い違った場合は `openapi.yaml` を正とする。`openapi-typescript` で生成した型を `apps/gateway`（ハンドラ I/O）と `apps/web` / `apps/agent`（呼び出し側）が共有し、API の形をレイヤーごとに手書きしない（FR-029 / SC-012）。API レイヤーの E2E は Postman コレクション + Newman（`apps/e2e/postman/`）で、実デプロイのレスポンスが `openapi.yaml` のスキーマに適合することを検証する。

**実装**: Hono 4 on Cloudflare Workers（`wrangler` デプロイ）。並行制御は Durable Object `ReceiptLock`、永続化は Hyperdrive→PostgreSQL ＋ Workers KV（`share_G`）＋ Workers Secrets Store（`share_U` / 署名鍵）。
**Base URL**: `https://gateway.<demo-host>.workers.dev` / **形式**: JSON over HTTPS / **認証**: EIP-712 署名（セッション Cookie なし、リクエストごとに署名）

すべての「認可判定」は Gateway がその場で Hedera を `eth_call` して行う（憲章 II）。DO / DB / KV は並行制御・鍵シェア・監査のみ（非権威）。

エラーは常に `{ code: ErrorCode, message, detail? }`（[error-codes.md](./error-codes.md)）。

---

## 発見・プレビュー（認可不要、FR-019）

### `GET /assets`
利用可能な資産の一覧（Gateway が subgraph をプロキシ + Manifest を展開）。
```json
[ { "assetId": "0x…", "tokenId": "1", "nftContract": "0x…",
    "previewURI": "ipfs://…", "manifestURI": "ipfs://…",
    "paidAccess": { "price": "100000", "durationSec": 300, "maxUses": 5 },
    "transferMode": "SURVIVE_TRANSFER", "permissions": {…} } ]
```

### `GET /assets/:assetId/preview`
公開プレビュー本体（またはリダイレクト）。認可なし。

---

## 所有者パス（無料アクセス、User Story 1 / FR-002 / FR-003）

### `POST /owner/challenge`
```json
→ { "tokenId": "1", "wallet": "0x…" }
← { "typedData": { …OwnerAuthChallenge… }, "nonce": "0x…", "expiresAt": 1780000000 }
```
- `nonce` を `auth_nonce` に保存（`chainId=296`, `purpose='owner-access'`, TTL 120s）。

### `POST /owner/keygate`
```json
→ { "tokenId": "1", "assetId": "0x…",
    "authSig": "0x…",        // OwnerAuthChallenge への署名（FR-024）
    "keyGateSig": "0x…" }    // KeyGateChallenge{assetId, purpose:"owner"} への署名
← { "shareG": "0x… (32 bytes)",
    "blindedU": "0x… (32 bytes)",
    "accessEpochAtGrant": 8,
    "encryptedContentURI": "ipfs://…", "contentHash": "0x…" }
```
**サーバ処理**
1. `nonce` 検証（未使用・未期限・`chainId` 一致）→ 否なら `NONCE_INVALID_OR_EXPIRED`
2. `authSig` から復元したアドレス == `wallet` → 否なら `SIGNATURE_INVALID`
3. `wallet.code.length == 0` → 否なら `CONTRACT_WALLET_UNSUPPORTED`（FR-025）
4. **`eth_call RightsNFT.ownerOf(tokenId) == wallet`** → 否なら `NOT_CURRENT_OWNER`（憲章 II、FR-002）
5. `accessEpoch := eth_call RightsNFT.accessEpoch(tokenId)`
6. `keyGateSig` から `share_U'` を導出できるよう、`blindedU := share_U XOR HKDF(keyGateSig, info)` を計算（`share_U` は KMS から一時参照、R-1）。`wallet_blinded_shares` に upsert（`path='owner'`, `access_epoch_at_grant=accessEpoch`）
7. `share_G` を復号（`DB_KEK`）して返す
8. `audit_log`（`action='owner_keygate'`, `outcome='allow'`）

> 旧所有者が古い `blindedU` を持っていても、この API は毎回 step 4 で現在の `ownerOf` を確認するため `share_G` を得られない（`OWNER_EPOCH_MISMATCH` 相当の `NOT_CURRENT_OWNER`）。→ FR-003 / SC-003。

---

## 購入者パス（x402、User Story 2 / FR-004〜009）

### `GET /assets/:assetId/paid`（未払い時）
`x402-express` が **HTTP 402** を返す。ボディに支払い条件（`accepts`）：
```json
{ "x402Version": 2,
  "accepts": [ { "scheme": "exact", "network": "hedera:testnet",
                 "asset": "native", "maxAmountRequired": "5000000000000000000",
                 "payTo": "0x…RightsRegistry",
                 "resource": "/assets/0x…/paid",
                 "extra": { "contractCall": "settleAndIssue", "value": "5000000000000000000",
                            "feePayer": "0.0.7162784", "receiptParamsTemplate": {…} } } ],
  "manifest": { …Rights Manifest 抜粋… } }
```
> `asset` の native 表記（`"native"` / ゼロアドレス等）と `x402Version` は day1（T020）で Blocky402 の `/supported` / `/verify` 仕様に合わせて確定する。`maxAmountRequired` / `value` は weibar（10^18 = 1 HBAR）。

### `POST /assets/:assetId/paid`（`X-PAYMENT` ヘッダ付き）
クライアント（web / agent）が `purchaseRequestHash` を計算し、`x402-fetch` で部分署名ペイロードを付けて再送。
1. `UNIQUE(payment_id, purchase_request_hash)` を `payment_binding` に INSERT → 衝突なら `PAYMENT_ID_PAYLOAD_CONFLICT`
2. Gateway（または facilitator）が `RightsRegistry.settleAndIssue(ReceiptParams)` を submit（R-2 primary）。`ownerEpochAtIssue` は事前に `eth_call accessEpoch` した値
3. tx 確定 → `receiptHash` を取得、`ReceiptIssued` を確認
4. `receipt/issue.ts` が EIP-712 Receipt に **サーバ署名**（利便クレデンシャル）
5. licensee 向け `blindedU`（`path='licensee'`, `receipt_hash`）を計算・保存
6. レスポンス：
```json
{ "receiptHash": "0x…", "receipt": { …17 フィールド… }, "serverSignature": "0x…",
  "onchainTx": "0x…", "maxUses": 5, "expiresAt": 1780000300 }
```
7. `audit_log`（`action='x402_settle'`）

> R-2 フォールバック時：step 2 は「buyer が `RightsRegistry.payFor{value}(paymentId)` で HBAR を預ける」→ 別途 `POST /assets/:assetId/finalize` が `RightsRegistry.finalize` を叩く。`share_G` 要求時に未 finalize なら `SETTLEMENT_NOT_FINALIZED`。

---

## KeyGate 復号（所有者・購入者共通の share_G 取得、FR-015 / FR-016）

### `POST /keygate/share`
```json
→ 所有者:  { "assetId": "0x…", "tokenId": "1", "path": "owner",
             "authSig": "0x…", "keyGateSig": "0x…" }
   購入者:  { "assetId": "0x…", "receiptHash": "0x…", "path": "licensee",
             "keyGateSig": "0x…" }   // KeyGateChallenge{assetId, purpose:"licensee", receiptHash}
← { "shareG": "0x…", "useIndex": 3, "onchainTx": "0x…" }   // 購入者は useIndex + consume tx を含む
```

**購入者パスのサーバ処理（R-3 の三層原子制御）**

Hono ハンドラは `receiptHash` から `env.RECEIPT_LOCK.get(idFromName(receiptHash))` を引き、以降の 1〜8 を **その Durable Object 内で直列に**実行する（同一 Receipt への 20 並列は DO のキューで 1 本化）。

1. `keyGateSig` 復元アドレス == `receipt.licensee` → 否なら `LICENSEE_MISMATCH`
2. **`eth_call RightsRegistry.receiptStatus(receiptHash)`** で `issued` / `expiresAt` / `usedCount` / `transferMode` / `licenseEpochAtIssue` を取得。EIP-712 ドメインの `chainId` チェックで `CHAIN_ID_MISMATCH`。`resourceHash`/`policyHash` を Manifest と照合 → 不一致なら `RESOURCE_HASH_MISMATCH` / `POLICY_HASH_MISMATCH`
3. `BEGIN; SELECT … FOR UPDATE receipt_consumption WHERE receipt_hash=$1;`（Hyperdrive→Postgres、DO を跨ぐ想定外の競合への defense-in-depth）
4. 次の `useIndex := usedCount`（オンチェーン値）。`INSERT receipt_consumption(receipt_hash, use_index, status='locked')`（`UNIQUE` 衝突 → 既に処理中/済み → `RECEIPT_ALREADY_CONSUMED`）
5. `COMMIT`
6. **`RightsRegistry.consume(receiptHash, useIndex)` を submit**（オンチェーン権威）。revert 時はその custom error を ErrorCode にマップ（`RECEIPT_EXPIRED` / `USE_LIMIT_EXCEEDED` / `LICENSE_INVALIDATED_ON_TRANSFER` / `LICENSE_EPOCH_MISMATCH` / `RECEIPT_ALREADY_CONSUMED`）→ `receipt_consumption.status='failed'`
7. tx 確定 → `status='settled'`, `onchain_tx` → **`share_G` を KV から取得・放出**（settle-before-release、憲章 V）
8. `audit_log`（`action='consume'`, `outcome='allow'` or `'deny:<code>'`）

**所有者パスのサーバ処理**：`/owner/keygate` と同一（consume は不要、`share_G` は毎回 `ownerOf`/`accessEpoch` 直読みでゲート）。

---

## Rights Graph プロキシ（Dashboard / Agent、FR-020）

### `GET /graph/query?…` または `POST /graph`
subgraph への GraphQL パススルー（+ `subgraph_cache` で即時性補完）。**このエンドポイントの結果を認可に使ってはならない**（FR-020、憲章 II）。

---

## 監査（審査員向け、FR-023）

### `GET /audit?assetId=…&since=…`
`audit_log` の抜粋（鍵操作・支払い・consume・deny・claim・policy_update）。デモの「攻撃が拒否される様子」の裏付け。

---

## レート制限（§9.2）

- プレビュー：IP ごと 60 req/min
- `/owner/challenge` `/keygate/share`：wallet ごと 30 req/min（Concurrent Replay テスト 20 並列は許容範囲内）
- 超過は `RATE_LIMITED`
