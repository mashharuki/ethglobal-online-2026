# ライブ審査 想定問答（T128）

4 分デモ + 3 分 Q&A を想定。各回答は 20〜30 秒で言い切れる長さに揃える。根拠の所在（コード・仕様）を併記する。

## 1. なぜサブスク API ではなくオンチェーンなのか

**答え**: 主張しているのは「静的データの配信」ではなく「権利状態の**原子的な切替**」。NFT の移転と同じトランザクションで Owner Epoch が進み（`RightsNFT._update` のみが更新、外部 setter なし）、旧所有者の無料アクセス失効・新所有者の付与・SURVIVE ライセンスの継続・INVALIDATE ライセンスの失効・将来収益の付替えが**同時に**確定する。サブスク API では「誰が今の所有者か」を API 提供者が握り、移転の事実と権利の切替が別々の帳簿に分かれる。

根拠: `apps/contracts/contracts/RightsNFT.sol`（`_update` override）、`RightsRegistry.hasValidConsumption`、`specs/.../contracts/solidity-interfaces.md`。

## 2. Gateway は何を握っているのか、本番ではどう分散するのか

**答え**: 握っているのは 3 つ。① Rights Receipt のサーバ署名鍵（利便クレデンシャル。認可の権威はチェーン上の `receiptStatus`）② `consume` を送る operator 鍵 ③ owner パスの `share_U`（ウォレット毎にブラインド化）。認可判定そのものは毎回 `ownerOf` / `accessEpoch` / `receiptStatus` を直読み。本番は ①②を複数 operator に分散、③は Shamir 2-of-3 で Gateway 単体が鍵素材を復元できない構成にする（設計のみ、未実装と明言）。

根拠: README「Trust model」、`apps/gateway/src/keygate/release.ts`、`chain/reads.ts`。

## 3. R-2 フォールバック（非原子でも安全と言える理由）

**答え**: primary は Blocky402 経由の 1 tx 決済（custodial rail）。fallback は `payFor{value}(paymentId, committedParamsHash)` + permissionless `finalize`。HBAR は `RightsRegistry` が保持し Gateway は custody しない、`finalize` は誰でも呼べるが `committedParamsHash`（licensee を含む ReceiptParams 全体のハッシュ）に一致する params でしか確定しない、timeout 後は `refundUnfinalized` で返金。「非原子」なのは決済と anchor の間だけで、資金の所在は常にコントラクト。

根拠: `RightsRegistry.sol`（`payFor` / `finalize` / `refundUnfinalized`）、`test/RightsRegistry.fallback.spec.ts`、`research.md` R-2a。

## 4. Rights Graph は load-bearing か

**答え**: 発見（`discover_assets` / Market 一覧）と監査（Dashboard・タイムライン）では load-bearing。**認可には一切使わない**（憲章 II）。Graph Node は `apps/cdk` の AWS EC2 に自前ホスト（Hedera は Subgraph Studio 非対応）、ハッカソン終了後に destroy。落ちた場合の最終手段は Hedera Mirror Node + `subgraph_cache`。The Graph の賞には submit していない。

根拠: `apps/subgraph/`、`apps/cdk/`、`apps/gateway/src/graph/cache.ts`、README「Sponsor tracks」。

## 5. 並行性の証明（20 並列）

**答え**: 3 層。① `ReceiptLock` Durable Object が `receiptHash` 単位で直列化し、`useIndex` を自前採番 ② Postgres `receipt_consumption` の `UNIQUE(receipt_hash, use_index)` ③ コントラクトの `consume` が `consumed[receiptHash][useIndex]` で二重消費を revert。テストは 3 層とも**実並列**（contract: Hardhat で 20 tx 同時送信、gateway: workerd で 20 リクエスト同時、e2e: 実 gateway に 20 並列で `1 settled / 19 × 409`、最遅拒否 < 3 s を要求）。

根拠: `apps/contracts/test/RightsRegistry.concurrent.spec.ts`、`apps/gateway/test/receiptLock.do.spec.ts`、`apps/e2e/attacks.e2e.ts` + `lib/gateway.ts` の `assertReplay`。

## 6. 「復号後は右クリック保存できるのでは」

**答え**: できる。主張は「静的データのコピー防止（DRM）」ではない。守っているのは**権利状態の同期**——誰が今アクセスでき、誰に将来収益が入り、どの Receipt が有効か。コピーされた平文は「その時点で正当に持っていた人のスナップショット」であり、移転後にその人が新しい版・新しい利用権・収益を得ることはない。

根拠: 憲章「非ゴール」（DRM としての主張なし）、README「Not supported」。

## 7. owner パスの `share_U` 残存信頼点

**答え**: 正直に言うと、owner（無料）パスでは Gateway が `share_U` を保持しているので、Gateway 侵害 = owner パスのコンテンツ流出。緩和として ①ウォレット毎の HKDF ブラインド化（`blindedU`、Gateway は wallet の署名を持たず K を組み立てられない設計だが `share_U` 自体は持つ）②監査ログに全 allow/deny ③計画は Shamir 2-of-3（creator / gateway / recovery）。購入者パスは `consume` の on-chain 確定が前提なので、Gateway 単独では useIndex を捏造できない。

根拠: `apps/gateway/src/keygate/split.ts`、`packages/shared/src/keygate.ts`、README「Trust model」。

## 8. コントラクトウォレット / ERC-1271 非対応

**答え**: 意図的な非ゴール。`settleAndIssue` は `licensee.code.length == 0` を要求し、EIP-712 の復元アドレス検証も EOA 前提。理由は 9 日間で「所有者が Safe のとき誰が署名者か」の判定（ERC-1271 の isValidSignature + 所有権の再解決）まで安全に作り切れないと判断したため。エラーは `CONTRACT_WALLET_UNSUPPORTED` として明示。

根拠: `RightsRegistry.sol`、`packages/shared/src/errors.ts`、憲章「非ゴール」。

## 9. 「x402 を安全にしたのか」

**答え**: 言わない。TrueCollective が実装したのは Rights Gateway における **request-binding**（`purchaseRequestHash` / `paymentId` の束縛、`PAYMENT_ID_PAYLOAD_CONFLICT`）、**idempotency**（`payment_binding` の claim / stage モデル）、**settle-before-release**（on-chain `consume` 確定後にのみ鍵素材放出）、**並行制御**（Q5）。x402 プロトコル自体には手を入れていない。

根拠: `apps/gateway/src/x402/settle.ts`、`contracts/error-codes.md`、憲章 VII。
