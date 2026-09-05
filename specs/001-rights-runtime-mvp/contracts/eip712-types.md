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

| フィールド | 由来 | 検証 |
|---|---|---|
| `chainId` / `verifyingContract` | Domain と一致 | EIP-712 検証で自動（`CHAIN_ID_MISMATCH`） |
| `nftContract` / `tokenId` | 購入対象 | `settleAndIssue` で `RightsNFT` を参照 |
| `resourceHash` | `keccak256(abi.encode(nftContract, tokenId, assetId, contentHash))` | Gateway が Manifest と照合（`RESOURCE_HASH_MISMATCH`） |
| `policyHash` | R-6 の policy 正規化ハッシュ | `RightsNFT.policyHash(tokenId)` と一致（`POLICY_HASH_MISMATCH`） |
| `licenseEpoch` | `RightsRegistry.licenseEpoch(tokenId)`（発行時） | `hasValidConsumption` で現在値と一致（`LICENSE_EPOCH_MISMATCH`） |
| `ownerEpochAtIssue` | `RightsNFT.accessEpoch(tokenId)`（発行時）。＝「Owner Epoch」、実フィールド名は `accessEpoch`（M1） | `INVALIDATE_ON_TRANSFER` のとき現在の `accessEpoch(tokenId)` と一致必須（`LICENSE_INVALIDATED_ON_TRANSFER`）。`SURVIVE_TRANSFER` は監査のみ |
| `licensee` | 購入者ウォレット | `keyGateSig` の復元アドレスと一致（`LICENSEE_MISMATCH`）。`code.length == 0`（`CONTRACT_WALLET_UNSUPPORTED`） |
| `permittedAction` | permissions ビットフラグ（bit0 commercialUse, bit1 aiTraining, bit2 derivativeGeneration）。Manifest `permissions` の 3 ブール（FR-004）を 1 バイトに畳んだもの。※名称は単数だが実体は許諾セット | 表示・監査用（MVP は enforcement しない） |
| `transferMode` | `0 = SURVIVE_TRANSFER`, `1 = INVALIDATE_ON_TRANSFER` | 上記 `ownerEpochAtIssue` の扱いを決める |
| `maxUses` | Manifest `paidAccess.maxUses` | `consume` で `useIndex < maxUses`（`USE_LIMIT_EXCEEDED`） |
| `expiresAt` | `issuedAt + durationSec` | `hasValidConsumption`（`RECEIPT_EXPIRED`） |
| `purchaseRequestHash` | `keccak256(abi.encode(httpMethod, canonicalPath, planId, resourceHash, policyHash))` | **アクセス（復号）呼び出し内容を含めない**（憲章 V）。`UNIQUE(payment_id, purchase_request_hash)` |
| `paymentId` | x402 の支払い ID | 一回限り（`PAYMENT_ID_PAYLOAD_CONFLICT`） |
| `nonce` | ランダム 32 バイト | `!issued[receiptHash]` と併せ二重発行防止 |
| `issuedAt` | settle tx の `block.timestamp` | 監査 |

## `KeyGateChallenge`（`share_U` blinding、R-1）

```
KeyGateChallenge(
  bytes32 assetId,
  string  purpose,        // "owner" | "licensee"
  bytes32 receiptHash     // licensee のとき Receipt、owner のとき 0x00..00
)
```
- このチャレンジは **固定**（nonce を含まない）。同じウォレット・同じ `assetId`・同じ `purpose` なら常に同じ署名 → 同じ `HKDF` 出力 → 同じ `share_U'`。ウォレットを跨いで安定。
- `share_U' = blindedU XOR HKDF-SHA256(sig, salt="", info=utf8("truenft/keygate/v1/" + assetIdHex))`（32 バイト出力）。

## `OwnerAuthChallenge`（所有者アクセスの署名要求、FR-024）

```
OwnerAuthChallenge(
  bytes32 nonce,
  uint256 chainId,
  uint256 tokenId,
  uint64  expiresAt
)
```
- `nonce` は Gateway 発行・一度きり（`auth_nonce`）。`expiresAt` は発行 + 120s。`chainId=296`。
- 別ネットワーク向けに署名された要求（`chainId` 不一致）は拒否（FR-024）。

## permittedAction ビットフラグ

| bit | 意味 |
|---|---|
| 0 | `commercialUse` |
| 1 | `aiTraining` |
| 2 | `derivativeGeneration` |

MVP では機械可読な提示のみ（FR-004）。オンチェーン enforcement は将来拡張。
