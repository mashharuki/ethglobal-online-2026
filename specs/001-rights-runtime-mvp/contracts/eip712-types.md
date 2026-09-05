# EIP-712 typed data の契約

`packages/shared/src/eip712.ts` が **唯一の実装**。Solidity（`ReceiptLib`）は同一ロジックを再実装し、CI の golden test（`packages/shared/test/eip712.golden.test.ts` ↔ `apps/contracts/test/ReceiptLib.golden.t.ts`）で「同一入力 → 同一 `receiptHash`」を検証する（憲章 IV / V、R-6）。

## Domain

```json
{ "name": "TrueCollective", "version": "1", "chainId": 296, "verifyingContract": "<RightsRegistry address>" }
```

- `chainId = 296`（Hedera Testnet）。mainnet 移行時は `295`。**別 `chainId` で署名された Receipt はドメイン不一致で失敗 → `CHAIN_ID_MISMATCH`**（§10.1 #5 / A-7）。

## `RightsReceipt`（`receiptHash = hashStruct(RightsReceipt)`）

```
RightsReceipt(
  uint256 chainId,
  address verifyingContract,
  address nftContract,
  uint256 tokenId,
  bytes32 resourceHash,
  bytes32 policyHash,
  uint256 licenseEpoch,
  uint256 ownerEpochAtIssue,
  address licensee,
  uint8   permittedAction,
  uint8   transferMode,
  uint32  maxUses,
  uint64  expiresAt,
  bytes32 purchaseRequestHash,
  bytes32 paymentId,
  bytes32 nonce,
  uint64  issuedAt
)
```

フィールド数は 17 のまま変更しない。`policyHash` 再導出検証（R-6a）に必要な `duration` は新規フィールドを追加せず、**`durationSec := expiresAt - issuedAt` として contract 内で逆算**する（下記「`policyHash` の再導出検証」参照）。

| フィールド | 由来 | 検証 |
|---|---|---|
| `chainId` / `verifyingContract` | Domain と一致 | EIP-712 検証で自動（`CHAIN_ID_MISMATCH`） |
| `nftContract` / `tokenId` | 購入対象 | `settleAndIssue` で `RightsNFT` を参照 |
| `resourceHash` | `keccak256(abi.encode(nftContract, tokenId, assetId, contentHash))` | Gateway が Manifest と照合（`RESOURCE_HASH_MISMATCH`） |
| `policyHash` | R-6 の policy 正規化ハッシュ | `RightsNFT.policyHash(tokenId)` と一致（`POLICY_HASH_MISMATCH`）**かつ**（2026-09-05 R-6a 追加）`keccak256(abi.encode(price, expiresAt-issuedAt, maxUses, permittedAction, transferMode, creatorBps, ownerBps))` と一致（`POLICY_CONTENT_MISMATCH`）。後者が無いと、正規の `policyHash` を使い回しつつ `price`/`maxUses` 等を自由に指定できてしまう（Critical、Codex #1 / Fable C-1） |
| `licenseEpoch` | `RightsRegistry.licenseEpoch(tokenId)`（発行時） | `hasValidConsumption` で現在値と一致（`LICENSE_EPOCH_MISMATCH`） |
| `ownerEpochAtIssue` | `RightsNFT.accessEpoch(tokenId)`（発行時）。＝「Owner Epoch」、実フィールド名は `accessEpoch`（M1） | `INVALIDATE_ON_TRANSFER` のとき現在の `accessEpoch(tokenId)` と一致必須（`LICENSE_INVALIDATED_ON_TRANSFER`）。`SURVIVE_TRANSFER` は監査のみ |
| `licensee` | 購入者ウォレット | `authSig`（`LicenseeAuthChallenge` への署名、R-1a）の復元アドレスと一致（`LICENSEE_MISMATCH`）。`code.length == 0`（`CONTRACT_WALLET_UNSUPPORTED`）。**`keyGateSig`（鍵導出用）はこの検証には使わない**（2026-09-06 訂正：R-1a で認証と鍵導出を分離した後の取り残し記述、Codex 指摘） |
| `permittedAction` | permissions ビットフラグ（bit0 commercialUse, bit1 aiTraining, bit2 derivativeGeneration）。Manifest `permissions` の 3 ブール（FR-004）を 1 バイトに畳んだもの。※名称は単数だが実体は許諾セット | 表示・監査用（MVP は enforcement しない） |
| `transferMode` | `0 = SURVIVE_TRANSFER`, `1 = INVALIDATE_ON_TRANSFER` | 上記 `ownerEpochAtIssue` の扱いを決める |
| `maxUses` | Manifest `paidAccess.maxUses` | `consume` で `useIndex < maxUses`（`USE_LIMIT_EXCEEDED`） |
| `expiresAt` | `issuedAt + durationSec`（`durationSec` は Manifest 由来、`policyHash` にも入力される） | `hasValidConsumption`（`RECEIPT_EXPIRED`）。加えて（2026-09-05 R-6a）`issuedAt` 自体が「見積（402 応答）時刻から一定窓内であること」を settle 時に検証（`EXPIRY_MISMATCH`、見積から settle までの race を許容しつつ古い見積の使い回しを防ぐ） |
| `purchaseRequestHash` | `keccak256(abi.encode(httpMethod, canonicalPath, planId, resourceHash, policyHash))` | **アクセス（復号）呼び出し内容を含めない**（憲章 V）。**`payment_binding.payment_id` は単独 PK（R-10・2026-09-06 訂正：旧 `UNIQUE(payment_id, purchase_request_hash)` の複合キーは「同一 payment_id・別内容」の共存を許してしまうため撤回）。`purchase_request_hash` は同一行内の内容一致確認にのみ使う** |
| `paymentId` | x402 の支払い ID | 一回限り（`PAYMENT_ID_PAYLOAD_CONFLICT`） |
| `nonce` | ランダム 32 バイト | `!issued[receiptHash]` と併せ二重発行防止 |
| `issuedAt` | settle tx の `block.timestamp` | 監査 |

## `KeyGateChallenge`（`share_U` blinding **専用**、R-1／2026-09-05 R-1a により用途を鍵導出に限定）

```
KeyGateChallenge(
  bytes32 assetId,
  string  purpose,        // "owner" | "licensee"
  bytes32 receiptHash     // licensee のとき Receipt、owner のとき 0x00..00
)
```
- このチャレンジは **固定**（nonce を含まない）。同じウォレット・同じ `assetId`・同じ `purpose` なら常に同じ署名 → 同じ `HKDF` 出力 → 同じ `share_U'`。ウォレットを跨いで安定。
- `share_U' = blindedU XOR HKDF-SHA256(sig, salt="", info=utf8("truenft/keygate/v1/" + assetIdHex))`（32 バイト出力）。
- **⚠ 2026-09-05 変更（R-1a・Critical、Fable C-3）**：この署名（`sig`）は **鍵導出にのみ**使う。以前の設計ではこの `sig` を `/owner/keygate` `/keygate/share` の**認証**にも流用していたが、固定チャレンジのため無期限にリプレイ可能で、`sig` は鍵導出素材そのものでもあるため、リクエスト認証には**絶対に使わない**。認証は下記 `OwnerAuthChallenge` / `LicenseeAuthChallenge` の nonce 付き署名で行う。`blindedU` の計算・保存は「初回アクセス成功時」の 1 回のみ行い、以降のリクエストではこの `KeyGateChallenge` への署名をクライアントに送らせない。

## `OwnerAuthChallenge`（所有者アクセスの署名要求、FR-024）

```
OwnerAuthChallenge(
  bytes32 nonce,
  uint256 chainId,
  uint256 tokenId,
  bytes32 assetId,        // 2026-09-05 追加（R-11・Fable H-10）：Cross-Resource 攻撃防止のため署名に束縛
  uint64  expiresAt
)
```
- `nonce` は Gateway 発行・一度きり（`auth_nonce`）。`expiresAt` は発行 + 120s。`chainId=296`。
- 別ネットワーク向けに署名された要求（`chainId` 不一致）は拒否（FR-024）。
- `assetId` を署名に含めることで、所有者が自分の `tokenId` の所有権を提示しつつ別資産の `assetId` を指定して `share_G` を騙し取る Cross-Resource 攻撃（R-11）を防ぐ。Gateway はこの `assetId` から Manifest を引いて `tokenId` を導出し、クライアントが別途送る `tokenId` とは照合のみに使う（権威は `assetId` → Manifest 側）。

## `LicenseeAuthChallenge`（購入者アクセスの署名要求、2026-09-05 新設・R-1a・Fable C-3 対応）

```
LicenseeAuthChallenge(
  bytes32 nonce,
  uint256 chainId,
  bytes32 receiptHash,
  uint64  expiresAt
)
```
- `nonce` は Gateway 発行・一度きり（`auth_nonce`、`purpose='keygate-challenge'`）。`expiresAt` は発行 + 120s。`chainId=296`。
- `POST /keygate/share`（licensee パス）は、この nonce 付き署名を**必須の認証**として要求する。`KeyGateChallenge` への署名（鍵導出用）はこの認証を置き換えない。

## permittedAction ビットフラグ

| bit | 意味 |
|---|---|
| 0 | `commercialUse` |
| 1 | `aiTraining` |
| 2 | `derivativeGeneration` |

MVP では機械可読な提示のみ（FR-004）。オンチェーン enforcement は将来拡張。
