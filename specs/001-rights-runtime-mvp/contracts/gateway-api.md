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
    "paidAccess": { "price": "5000000000000000000", "durationSec": 300, "maxUses": 5 },
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
→ { "assetId": "0x…",
    "authSig": "0x…",        // OwnerAuthChallenge{nonce, chainId, tokenId, assetId} への署名（FR-024・2026-09-05 assetId 追加）
    "keyGateSig": "0x…" }    // 初回のみ：KeyGateChallenge{assetId, purpose:"owner"} への署名（R-1a・以降のアクセスでは省略可）
← { "shareG": "0x… (32 bytes)",
    "blindedU": "0x… (32 bytes)",   // 初回計算時のみ新規値。以降は既存値を返すのみ
    "accessEpochAtGrant": 8,
    "ownerSession": { "token": "0x…", "expiresAt": 1780003600 },
    "encryptedContentURI": "ipfs://…", "contentHash": "0x…" }
```
**サーバ処理（2026-09-05 修正：R-1a 認証分離・R-11 Cross-Resource 対策を反映。`tokenId` は request から受け取らない）**
1. `nonce` 検証（未使用・未期限・`chainId` 一致）→ 否なら `NONCE_INVALID_OR_EXPIRED`
2. **`assetId` から Rights Manifest を引き `manifest.tokenId` / `manifest.nftContract` を導出する**（クライアントは `tokenId` を送らない。R-11：owner が自分の NFT の所有権を提示しつつ別資産の `share_G` を騙し取る Cross-Resource 攻撃を、`tokenId` をサーバ側で確定させることで防ぐ）
3. `authSig` から復元したアドレス == `wallet` → 否なら `SIGNATURE_INVALID`。`authSig` が束縛する `assetId` が request の `assetId` と一致 → 否なら `SIGNATURE_INVALID`
4. `wallet.code.length == 0` → 否なら `CONTRACT_WALLET_UNSUPPORTED`（FR-025）
5. **`eth_call RightsNFT.ownerOf(manifest.tokenId) == wallet`** → 否なら `NOT_CURRENT_OWNER`（憲章 II、FR-002）
6. `accessEpoch := eth_call RightsNFT.accessEpoch(manifest.tokenId)`
7. `wallet_blinded_shares` に `(assetId, wallet, path='owner')` の既存行があれば `blindedU` はそれを再利用する。**無ければ**（初回アクセス）`keyGateSig`（必須）から `blindedU := share_U XOR HKDF(keyGateSig, info)` を計算して upsert（`access_epoch_at_grant=accessEpoch`）。**`keyGateSig` は認証には使わない**（R-1a）
8. `share_G` を復号（`DB_KEK`）して返す。**所有者セッションクレデンシャル**（`ownerSession`、Gateway 署名の短命トークン、TTL = `ownerAccess.durationSec`、`accessEpochAtGrant` を埋め込む）を新規発行して返す
9. `audit_log`（`action='owner_keygate'`, `outcome='allow'`）。**`authSig` / `keyGateSig` の値そのものは記録しない**（R-1a）

> 旧所有者が古い `blindedU` を持っていても、この API は毎回 step 5 で現在の `ownerOf` を確認するため `share_G` を得られない（`OWNER_EPOCH_MISMATCH` 相当の `NOT_CURRENT_OWNER`）。→ FR-003 / SC-003。
>
> **`ownerSession` 提示時の判定順位（2026-09-05 追加、Fable H-3 対応）**：クライアントが以前発行された `ownerSession.token` を提示した場合、まず `accessEpoch(manifest.tokenId)` を再読して `ownerSession` 埋め込みの `accessEpochAtGrant` と比較する — 不一致なら（この時点では `ownerOf` を見ずに）`OWNER_EPOCH_MISMATCH` を返す。セッション自体が無い、または検証不能な場合のみ `ownerOf` 不一致で `NOT_CURRENT_OWNER` を返す。セッションは認可の根拠ではなくエラー選択のためのメタデータであり、`ownerOf` / `accessEpoch` の直読み（step 5-6）は**セッションの有無に関わらず毎回実行する**（憲章 II）。

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

**payment_binding の一意性・冪等性（2026-09-05 修正、R-10・Codex #5／Fable H-2 対応）**
1. `payment_id` を PK として `payment_binding` に INSERT を試みる。
   - 衝突なし → 新規行を `status='pending'` で作成し、次のステップへ。
   - 衝突あり かつ 既存行の `purchase_request_hash` == 今回のもの → `status='settled'` なら**冪等応答**（保存済みの `receiptHash`/レスポンスをそのまま返す。settle を再実行しない）。**`status='pending'`（2026-09-06 修正、Codex 指摘：元の処理がまだ実行中の可能性がある）→ 新規に settle を起動せず、短いポーリング（1s 間隔・最大 10s）で `status` 変化を待つ。`settled` になれば冪等応答、変わらなければ `SETTLEMENT_IN_PROGRESS`（補助コード）を返す**。`status='failed'`（facilitator タイムアウト等で前回試行の失敗が確定済み）のときのみ settle を再試行する。
   - 衝突あり かつ 既存行の `purchase_request_hash` が異なる → `PAYMENT_ID_PAYLOAD_CONFLICT`。
   - `payment_id` はクライアントの自由入力にせず、**buyer 署名ペイロード（`X-PAYMENT` の署名対象）の keccak** から Gateway 側で決定的に導出する（2026-09-06 訂正：facilitator の settle 応答〔tx id〕は settle 後にしか得られず、settle 前の INSERT には使えない循環依存だったため撤回。買い手署名は受信時点で既に手元にある）。
2. Gateway（または facilitator）が `RightsRegistry.settleAndIssue(ReceiptParams)` を submit（R-2 primary）。`ownerEpochAtIssue` は事前に `eth_call accessEpoch` した値
3. tx 確定 → `receiptHash` を取得、`ReceiptIssued` を確認。`payment_binding.status` を `'settled'` に更新（tx revert なら `'failed'`）
4. `receipt/issue.ts` が EIP-712 Receipt に **サーバ署名**（利便クレデンシャル）
5. licensee 向け `blindedU`（`path='licensee'`, `receipt_hash`）を計算・保存
6. レスポンス：
```json
{ "receiptHash": "0x…", "receipt": { …17 フィールド… }, "serverSignature": "0x…",
  "onchainTx": "0x…", "maxUses": 5, "expiresAt": 1780000300 }
```
7. `audit_log`（`action='x402_settle'`）

> R-2 フォールバック時（2026-09-05 修正、R-2a・Codex #2 Critical 対応）：step 2 は「buyer が `RightsRegistry.payFor{value}(paymentId, committedParamsHash)` で HBAR を預け、**`ReceiptParams` 全体（`licensee` を含む全フィールド）のハッシュ**を入金時点に固定する」→ 別途 `POST /assets/:assetId/finalize` が `RightsRegistry.finalize(paymentId, receiptParams)` を叩く。`finalize` は渡された `receiptParams` から `keccak256(abi.encode(p))` を再計算し一致を検証（不一致は `COMMITTED_PARAMS_MISMATCH`）——これにより「別人の入金を攻撃者の資産の収益として finalize する」転用を防ぐ。**`purchaseRequestHash` は `licensee` を含まないため `committedParamsHash` に使ってはならない**（2026-09-05 追記、Codex 指摘・licensee 未束縛のまま finalize される穴が残る）。`share_G` 要求時に未 finalize なら `SETTLEMENT_NOT_FINALIZED`。

---

## KeyGate 復号（所有者・購入者共通の share_G 取得、FR-015 / FR-016）

### `POST /keygate/share`
```json
→ 所有者:  { "assetId": "0x…", "path": "owner",
             "authSig": "0x…", "keyGateSig": "0x…" }   // /owner/keygate と同一（2026-09-05：tokenId は送らない、R-11）
   購入者:  { "assetId": "0x…", "receiptHash": "0x…", "path": "licensee",
             "authSig": "0x…",                          // LicenseeAuthChallenge{nonce, chainId, receiptHash, expiresAt} への署名（必須、R-1a）
             "keyGateSig": "0x…" }                       // 初回のみ：KeyGateChallenge{assetId, purpose:"licensee", receiptHash}（R-1a）
← { "shareG": "0x…", "useIndex": 3, "onchainTx": "0x…" }   // 購入者は useIndex + consume tx を含む
```

**購入者パスのサーバ処理（R-3 の三層原子制御、2026-09-05 修正：R-1a 認証分離・R-3a useIndex 採番方式変更・クラッシュ復旧を反映）**

Hono ハンドラは `receiptHash` から `env.RECEIPT_LOCK.get(idFromName(receiptHash))` を引き、以降の 1〜9 を **その Durable Object 内で直列に**実行する（同一 Receipt への 20 並列は DO のキューで 1 本化）。

1. `nonce` 検証（`LicenseeAuthChallenge`、未使用・未期限・`chainId` 一致）→ 否なら `NONCE_INVALID_OR_EXPIRED`。`authSig` 復元アドレス == `receipt.licensee` → 否なら `LICENSEE_MISMATCH`（**認証は `authSig` で行う。`keyGateSig` は認証に使わない**、R-1a）
2. **`eth_call RightsRegistry.receiptStatus(receiptHash)`** で `issued` / `expiresAt` / `usedCount` / `transferMode` / `licenseEpochAtIssue` を取得。EIP-712 ドメインの `chainId` チェックで `CHAIN_ID_MISMATCH`。`resourceHash`/`policyHash` を Manifest と照合 → 不一致なら `RESOURCE_HASH_MISMATCH` / `POLICY_HASH_MISMATCH`
3. `BEGIN; SELECT … FOR UPDATE receipt_consumption WHERE receipt_hash=$1;`（Hyperdrive→Postgres、DO を跨ぐ想定外の競合への defense-in-depth）
4. **次の `useIndex` は DO 自前の採番カウンタから払い出す**（R-3a：DO 起動時のみ `usedCount`（オンチェーン）で初期化し、以降は DO storage のカウンタをインクリメント。`eth_call usedCount` を都度読まないことで、mirror node の反映遅延による誤った再採番を防ぐ）。`INSERT receipt_consumption(receipt_hash, use_index, status='locked')`（`UNIQUE` 衝突時は下記の復旧ロジックへ）
5. **`UNIQUE` 衝突時の復旧（2026-09-05 追加、R-3a・Codex #10／Fable H-6 対応。2026-09-06 訂正：別 `useIndex` への再採番は誤りだったため同一 `useIndex` での再送に修正）**：既存行が `status='locked'` かつ `now - created_at > 60s` なら、まずオンチェーンの `consumed[receiptHash][useIndex]` を直接確認する。`true` → 既存行を `status='settled'` に補正し既存の再配信規則（TTL 5 分）へ。`false` → 既存行を `status='failed'` にし、**同一の `useIndex` で** `consume` を再送する（別の `useIndex` へ進めてはならない ― `maxUses=1` のような境界で、未送信のまま失敗した index 0 を放棄して index 1 を新規採番すると `index 1 >= maxUses` で `USE_LIMIT_EXCEEDED` となり、支払い済みの利用権が消費されずに失われる。Codex bounded exec レビュー指摘）。`status='locked'` かつ 60s 以内なら `RECEIPT_ALREADY_CONSUMED`（処理中）
6. `COMMIT`
7. **`RightsRegistry.consume(receiptHash, useIndex)` の送出は `OperatorTxQueue` DO（R-3a）に依頼**（オンチェーン権威。nonce 採番の集約により異なる `receiptHash` 間の tx 競合を防ぐ）。revert 時はその custom error を ErrorCode にマップ（`RECEIPT_EXPIRED` / `USE_LIMIT_EXCEEDED` / `LICENSE_INVALIDATED_ON_TRANSFER` / `LICENSE_EPOCH_MISMATCH` / `RECEIPT_ALREADY_CONSUMED` / `NOT_AUTHORIZED`）→ `receipt_consumption.status='failed'`
8. tx 確定 → `status='settled'`, `onchain_tx` → **`share_G` を KV から取得・放出**（settle-before-release、憲章 V）
9. `audit_log`（`action='consume'`, `outcome='allow'` or `'deny:<code>'`）。**`authSig` / `keyGateSig` の値は記録しない**（R-1a）

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
