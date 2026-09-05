# エラーコード（公開契約）

**憲章「エラーコードは公開契約」**：以下の識別子は tests / demo / Dashboard / API が依存する安定 ID。改名は破壊的変更。

`packages/shared/src/errors.ts` に単一の `enum ErrorCode` として定義し、
- Solidity は同名の `error` を `RightsRegistry` / `RightsNFT` の custom error に持つ
- Gateway は `ErrorCode → HTTP status + JSON body {code, message, detail?}` にマップ
- subgraph は該当なし（成功イベントのみ index）

## §10.1 攻撃・異常系マトリクス（14 行 ＝ 拒否 13 行〔一意コード 12 種〕＋ 正常系 1 行）— 受け入れテスト（憲章 IV）

| # | ErrorCode | HTTP | 発生レイヤー | トリガ（テストの実行方法） |
|---|---|---|---|---|
| 1 | `RECEIPT_ALREADY_CONSUMED` | 409 | contract（`consume`）+ gateway | 同じ `(receiptHash, useIndex)` を 2 回 |
| 2 | `RECEIPT_ALREADY_CONSUMED`（並行） | 409 | contract + gateway | 同じ `(receiptHash, useIndex)` を 20 並列（成功 1・拒否 19・< 3s、SC-005） |
| 3 | `RESOURCE_HASH_MISMATCH` | 403 | gateway（`resourceHash` 照合）+ contract（`settleAndIssue`） | 資産 A の Receipt で資産 B にアクセス |
| 4 | `POLICY_HASH_MISMATCH` | 403 | gateway + contract | ポリシーを改変して送る（`policyHash` 不一致） |
| 5 | `CHAIN_ID_MISMATCH` | 403 | gateway（EIP-712 検証） | 別 `chainId` を埋めて署名した Receipt を単一デプロイ先へ（A-7） |
| 6 | `LICENSEE_MISMATCH` | 403 | gateway | Receipt の `licensee` と異なるウォレットの署名で `share_G` 要求 |
| 7 | `RECEIPT_EXPIRED` | 403 | contract（`hasValidConsumption`）+ gateway | `expiresAt` 経過後に利用 |
| 8 | `USE_LIMIT_EXCEEDED` | 403 | contract（`consume`）+ gateway | `usedCount == maxUses` の後にさらに利用 |
| 9 | `UNDERPAYMENT` | 402 | contract（`settleAndIssue` の `require(msg.value == price)` が revert） | 必要額と異なる HBAR 額（`msg.value`）で settle |
| 10 | `PAYMENT_ID_PAYLOAD_CONFLICT` | 409 | gateway（`UNIQUE(payment_id, purchase_request_hash)`）+ contract（`!issued` + nonce） | 同じ `paymentId` で異なる body |
| 11 | `OWNER_EPOCH_MISMATCH` | 403 | gateway（`accessEpoch` 直読み） | NFT 移転後、**移転前に発行された所有者セッションを提示して**アクセス（`accessEpoch(tokenId) != セッションの accessEpochAtGrant`）。セッション無しの新規要求で現在所有者と不一致の場合は `NOT_CURRENT_OWNER`（補助コード）。両方成立時は `OWNER_EPOCH_MISMATCH` を優先 |
| 12 | `PAID_LICENSE_TRANSFER_OK` | 200 | — | `SURVIVE_TRANSFER` Receipt を移転後に利用 → **成功**（負のテスト＝拒否されないこと） |
| 13 | `LICENSE_INVALIDATED_ON_TRANSFER` | 403 | contract（`hasValidConsumption`）+ gateway | `INVALIDATE_ON_TRANSFER` Receipt を移転後に利用（v1.5） |
| 14 | `LICENSE_EPOCH_MISMATCH` | 403 | contract + gateway | `bumpLicenseEpoch` 後に旧 Receipt を利用 |

> #2 は #1 と同じ ErrorCode だが独立したテストケース（並行）。#12 は成功を期待する検証。

## 補助コード（正常系のガードで返る）

| ErrorCode | HTTP | 用途 |
|---|---|---|
| `NONCE_INVALID_OR_EXPIRED` | 401 | `OwnerAuthChallenge` / `LicenseeAuthChallenge` の nonce 再利用・期限切れ（FR-024。**2026-09-05 R-1a 改訂**：`KeyGateChallenge` は鍵導出専用に用途限定され、この nonce 検証の対象からは外れる） |
| `SIGNATURE_INVALID` | 401 | EIP-712 署名の復元アドレス不一致 |
| `NOT_CURRENT_OWNER` | 403 | 所有者パスで、有効なセッション提示が無く `ownerOf(tokenId) != caller`（FR-002 / FR-003(b)）。移転前セッションの提示時は `#11 OWNER_EPOCH_MISMATCH` が優先 |
| `CONTRACT_WALLET_UNSUPPORTED` | 400 | `ownerOf` / `licensee` がコード付きアドレス（コントラクトウォレット、FR-025） |
| `CONDITIONS_HASH_MISMATCH` | 403 | Manifest の `keyGate.conditionsHash` が登録値と不一致（改ざん検知） |
| `SETTLEMENT_NOT_FINALIZED` | 409 | R-2 フォールバック時、`finalize` 未完了で `share_G` 要求 |
| `MANIFEST_SCHEMA_INVALID` | 422 | zod バリデーション失敗（Creator の登録時） |
| `RATE_LIMITED` | 429 | レート制限（§9.2） |
| `POLICY_CONTENT_MISMATCH` | 403 | **2026-09-05 追加（R-6a、Critical・Codex #1／Fable C-1 独立一致）**：`policyHash` が `price`/`maxUses`/`transferMode` 等の内容から再計算した値と不一致（正規の `policyHash` を使い回しつつ内容だけ改変した攻撃を検出） |
| `EXPIRY_MISMATCH` | 403 | **2026-09-05 追加（R-6a）**：`issuedAt` が見積（402 応答）時刻から許容窓を超えている（古い見積の使い回し防止） |
| `COMMITTED_PARAMS_MISMATCH` | 409 | **2026-09-05 追加（R-2a、Codex #2 Critical）**：R-2 フォールバックの `finalize` で、渡された `receiptParams` が `payFor` 時に固定した `committedParamsHash` と不一致（誰でも呼べる `finalize` による収益転用の防止） |
| `MCP_SESSION_MISMATCH` | 403 | **2026-09-05 追加（R-9a、Fable H-1 発見）**：MCP `decrypt_content` に渡された `receiptHash` が、呼び出し元と異なる `Mcp-Session-Id` で購入されたもの（`receiptHash` は subgraph 等で公開されるため、この確認が無いと第三者が他人の購入済みコンテンツを読める） |

## JSON エラー body（Gateway）

```json
{ "code": "OWNER_EPOCH_MISMATCH",
  "message": "This session predates an NFT transfer. Re-verify ownership.",
  "detail": { "tokenId": "1", "sessionEpoch": 7, "currentEpoch": 8 } }
```
