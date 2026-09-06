---
description: "実装タスク: Transfer-Coupled Rights Runtime MVP"
---

# Tasks: Transfer-Coupled Rights Runtime MVP

**Input**: `specs/001-rights-runtime-mvp/`（[plan.md](./plan.md) / [spec.md](./spec.md) / [research.md](./research.md) / [data-model.md](./data-model.md) / [contracts/](./contracts/) / [quickstart.md](./quickstart.md)）

**Tests**: **含む（必須）**。憲章 IV（NON-NEGOTIABLE）＝ `contracts/error-codes.md` の 14 行（拒否 13 行〔一意コード 12 種〕＋ 負のテスト 1 行 `PAID_LICENSE_TRANSFER_OK`）と主要ハッピーパスは、**それぞれのレイヤーの実装より前に red で書く**。SC-010 も自動検証を要求。

**Organization**: **レイヤー（水平）分割**。開発量が非常に多いため、`ベース → コントラクト → インデクサ → CDK → E2E#1 → gateway → E2E#2 → web → E2E#3 → agent → ドキュメント` の順に、各レイヤーを完成させてから次へ進む。レイヤー間に **E2E チェックポイント**（Phase 6 / 8 / 10）を置き、そこを通過するまで次のレイヤーに着手しない。

> **トレードオフ（承知の上で採用）**：この順序では画面デモが可能になるのは Phase 9（web）完了後。代わりに Phase 6（オンチェーン+インデクサ）・Phase 8（API）・Phase 10（画面）の 3 つの E2E ゲートで段階的に確証を積み上げ、提出動画は各ゲート通過時点で該当区間を分割収録する。day1 hard gate（Phase 2）は不変。

## Format: `[ID] [P?] Description`

- **[P]**: 並行可（別ファイル・未完了タスクへの依存なし）
- レイヤー：`apps/contracts/`（Solidity/Hardhat/Hedera）・`apps/subgraph/`（The Graph）・`apps/cdk/`（AWS CDK、self-hosted Graph Node、ハッカソン期間のみ）・`apps/gateway/`（Hono/Cloudflare Workers。MCP Server を `src/mcp/` に相乗り）・`apps/web/`（Vite/React/Tailwind/Privy）・`apps/agent/`（Node/Claude、CI 検証ハーネス専用）・`apps/e2e/`（Playwright + Postman/Newman）・`packages/shared/`（ドメイン型・エラーコード・EIP-712・ハッシュ）・`packages/openapi/`（Access Gateway HTTP API の OpenAPI 定義 + 生成型、FR-029）
- 決済資産は **ネイティブ HBAR**（Blocky402 の対応制約、v1.8 / 憲章 v1.3.0）。金額は weibar（10^18 = 1 HBAR、10^10 の倍数）。

---

## Phase 1: プロジェクト基盤セットアップ

**Purpose**: モノレポ・ツールチェーン・全 workspace の空スケルトン。

- [x] T001 リポジトリ直下に pnpm workspace を作成：`package.json`（scripts: `dev` / `build` / `test` / `lint` / `check` / `typecheck`）・`pnpm-workspace.yaml`（globs = `apps/*` / `packages/*`）。`apps/` に `contracts` / `subgraph` / `cdk` / `gateway` / `web` / `agent` / `e2e`、`packages/` に `shared` / `openapi` のディレクトリを用意
- [x] T002 [P] `turbo.json`：タスクグラフ `apps/contracts#compile / packages/openapi#generate → packages/shared#build → (apps/gateway#build / apps/web#build / apps/agent#build)`、`lint` / `test` / `typecheck` パイプライン。`apps/cdk` は `typecheck` / `lint` のみ（`deploy` は turbo 外・手動）
- [x] T003 [P] `tsconfig.base.json`：`strict`、`moduleResolution: "bundler"`、path alias `@/*`、`verbatimModuleSyntax`
- [x] T004 [P] `biome.json`：lint + format 一括。`.claude/rules/code-style.md` を反映（`noVar` / `useConst` / `useImportType` / early-return / boolean 命名）
- [x] T005 [P] `knip.json`：各 workspace（`apps/*` / `packages/*`）の entry 宣言。未使用 file / export / dependency 検出
- [x] T006 [P] `.jscpd.json`：`apps/gateway`/`apps/web`/`apps/agent` 間のロジック重複（ハッシュ計算・EIP-712 型）を検出するしきい値
- [ ] T007 [P] `.env.example`：`HEDERA_RPC_URL` / `HEDERA_OPERATOR_KEY` / `X402_FACILITATOR_URL`（`https://api.testnet.blocky402.com`）/ `PAYMENT_ASSET`（`native`）/ `ANTHROPIC_API_KEY` / `HYPERDRIVE_URL` / `WEB3_STORAGE_TOKEN` / `SUBGRAPH_URL` / `GRAPH_NODE_HOST` / `GATEWAY_URL` / `AWS_REGION`。**USDC 系 env は無し**
- [x] T008 [P] `vitest.workspace.ts`（`packages/shared` / `packages/openapi` / `apps/gateway`〔`@cloudflare/vitest-pool-workers`〕/ `apps/web` / `apps/agent`）＋ `apps/e2e/` 足場：`playwright.config.ts`、`postman/`（空の `gateway.postman_collection.json` + `hedera-testnet.postman_environment.json`）、`pnpm --filter e2e test:api`（`newman run`）script、共有ヘルパ `wallets.ts`（資金付きテストアカウント読み込み）
- [x] T009 [P] `packages/shared/` を init（`package.json` / `tsconfig` / `src/` / `abi/` 空）
- [x] T010 [P] `packages/openapi/` を scaffold：`openapi.yaml`（OpenAPI 3.1 の骨組み ― `info` / `servers` / 空の `paths` / `components.schemas` に `Error`〔`{code,message,detail?}`〕と `ErrorCode` enum プレースホルダ）、`openapi-typescript` + `@redocly/cli` を devDeps、`package.json`（`exports: { ".": "./src/index.ts" }`、scripts `generate` = `openapi-typescript openapi.yaml -o src/types.ts` / `lint` = `redocly lint openapi.yaml`）、`src/index.ts`（生成型 re-export）。生成物のコミット方針を明記
- [x] T011 [P] `apps/contracts/` を Hardhat 3 で init（`hedra-sample/hardhat-erc-721-mint` 準拠）：`hardhat.config.ts`（Solidity `0.8.34`、`evmVersion: "cancun"`、optimizer runs 200、network `testnet`）、`@nomicfoundation/hardhat-toolbox-mocha-ethers` + `@nomicfoundation/hardhat-verify`、OpenZeppelin Contracts `5.x`（`ReentrancyGuard` / `Address`）
- [x] T012 [P] `apps/subgraph/` を graph-cli で init（`hedra-sample/hedera-subgraph-example` 準拠）：`specVersion 0.0.4` / `apiVersion 0.0.6` / `network: testnet` / `subgraph.template.yaml`。`matchstick-as`（`graph test`）を devDep に追加
- [x] T013 [P] `apps/cdk/` を AWS CDK（TypeScript、`aws-cdk-lib` 2.x）で init：`bin/cdk.ts` / `lib/graph-node-stack.ts`（空 Stack）/ `docker/` / `cdk.json` / `package.json`（scripts `deploy` / `destroy` / `test`）
- [x] T014 [P] `apps/gateway/` を Hono + Cloudflare Workers で init：`wrangler.toml`（`durable_objects` = `ReceiptLock` + migration、`kv_namespaces` = `SHARE_G`、`hyperdrive` binding、`main = "src/index.ts"`、`compatibility_flags = ["nodejs_compat"]`）、`hono` + `x402-hono` + `viem` + `drizzle-orm` + `postgres` + `@noble/hashes` + `@noble/curves` + `zod` + `@truenft/openapi` を依存追加。`wrangler kv namespace create SHARE_G` / `wrangler hyperdrive create` の id を注入、`wrangler secret put` 対象（`SHARE_U_*` / `RECEIPT_SIGNER_KEY` / `KV_KEK` / `HEDERA_OPERATOR_KEY`）を `apps/gateway/SECRETS.md` に列挙
- [x] T015 [P] `apps/gateway/src/mcp/` を init（`@modelcontextprotocol/sdk` Streamable HTTP、空の `McpServer`）＋ **Privy Server SDK**（`@privy-io/server-auth` 等）を依存追加（R-9 / FR-028）。`apps/agent/` を CI 検証ハーネスとして init：`@anthropic-ai/sdk` + 自前 MCP クライアント + `tsx`
- [x] T016 [P] `apps/web/` を Vite + React 18 + TS で init：`@tailwindcss/vite`、`src/index.css` に `@import "tailwindcss"`、`tailwind.config.ts`（トークンのみ）、`@privy-io/react-auth` + `viem` + `x402-fetch` + `graphql-request` + `openapi-fetch` + `@truenft/openapi` を依存追加
- [ ] T017 [P] `.github/workflows/ci.yml`：`pnpm install` → `packages/openapi#generate` → `turbo run typecheck lint test` → `knip` → `jscpd` → `redocly lint packages/openapi/openapi.yaml` → `apps/contracts` の Hedera Testnet 統合ジョブ（憲章 III）→ `newman run apps/e2e/postman/gateway.postman_collection.json`。あわせて `scripts/audit-no-mocks.sh`（コア経路に mock/stub/ハードコード応答が無いことを grep、SC-009）を作成し CI に載せる。`apps/cdk` は `typecheck` / `lint` のみ

**Checkpoint**: `pnpm run check` が空プロジェクトで通る。全 workspace が空スケルトンで存在。

---

## Phase 2: 共有基盤 & day1 疎通ハードゲート

**⚠️ CRITICAL**: T018–T021 の結果を **09-04 終業までに確定**。9 日プランの前提。ここが崩れたら tripwire（下記）で設計を落とす。

### day1 hard gate（`research.md` の「⚠ day1 検証」）

- [ ] T018 [P] `apps/contracts/scripts/probe-hedera.ts`：最小の `payable` コントラクトを Testnet へ。**ネイティブ HBAR value の挙動**を記録（R-4）：`msg.value` が weibar（10^18）／native 精度下限 tinybar（10^8）＝ 金額は 10^10 weibar の倍数／`payable` への value 添付／**`msg.value / 1e10` の tinybar 変換とその後の tinybar 単位 `mulDiv` 2 者分配で dust が常にゼロ〜数 tinybar に収まること（2026-09-05 R-4 改訂：会計は tinybar 単位に統一。weibar のまま分配する旧設計は撤回）**／`.call{value:}` の払い出し・返金の成否ハンドリング
- [ ] T019 [P] `apps/gateway/scripts/probe-workerd.ts` + `apps/gateway/test/probe.spec.ts`：`viem` / `@noble/*` / `postgres`（Hyperdrive）/ `ReceiptLock` DO が `workerd`（`@cloudflare/vitest-pool-workers`）で動く（R-7）。**`@modelcontextprotocol/sdk` の Streamable HTTP を最小 `McpServer` として `wrangler dev` で立て、外部 MCP クライアント（Claude Code / `mcp` CLI）から `tools/list` が返る**（FR-026・デモ中核。Workers の実行時間制限・SSE・DO 要否をここで判断）
- [ ] T020 [P] `apps/gateway/scripts/probe-x402.ts` ＋ `apps/contracts/contracts/probe/ProbeSettle.sol`（**使い捨てスタンドイン**：`function settleAndIssue(bytes calldata receiptParams, uint256 price) external payable` ＋ `require(msg.value == price)` ＋ event emit だけ、**加えて `function payFor(bytes32 paymentId) external payable` も同一スタンドインに用意し primary/fallback 両方の ContractCall 対応を 1 回の probe で確認する（2026-09-05 R-2a 追加、Codex #4／Fable C-2 対応）**。**`ReceiptParams` struct には依存しない**〔本番の struct は `ReceiptLib.sol`・Phase 3・T041〕。`hardhat.config.ts` / `deploy.ts` の対象から `contracts/probe/` を除外し、Phase 3 開始時に削除）：**Blocky402**（`https://api.testnet.blocky402.com`、Hedera「AI & Agentic Payments」トラック必須）の `/supported` を叩く（`hedera:testnet` / `exact` / `feePayer 0.0.7162784` は確認済み）。**ネイティブ HBAR value を添付した ContractCall ペイロード**（スタンドイン契約の `settleAndIssue{value: price}` および `payFor{value: price}` の 1 tx）を verify / settle できるかを確認（R-2 / R-2a）。決済メカニズム（署名認可の形式、facilitator submit か buyer submit か、`feePayer` の役割、`asset` フィールドで native をどう表すか、`x402Version` 2 の形式）も記録。primary 不可なら「`payFor{value}` + permissionless `finalize`（`committedParamsHash` 付き、R-2a）」フォールバックを採用し、primary・fallback 双方が不可なら **第 3 案（非原子カストディ型、`research.md` R-2a に文書化済み）**へ。結果を `research.md` R-2 / R-2a と `plan.md` Complexity Tracking の条件付き行へ反映（T045/T046/T084 の primary/fallback/第3案 配線を確定）
- [ ] T021 [P] `apps/cdk/scripts/probe-graph-node.sh`：Subgraph Studio の Hedera 対応を再確認（対応済みなら submit 対象を再検討）。非対応前提で **`cdk deploy` の最小版で EC2 + docker-compose を建て**、`hedra-sample/hedera-subgraph-example` の手順で最小 subgraph を `graph deploy` → クエリ疎通（R-5、EC2 インスタンスタイプ / EBS サイズ / Hedera relay を provider にした同期速度も記録）。**probe 後は `cdk destroy` してよい**（本番建ては Phase 5）

**day1 ゲート結果**：4 項目の可否を `research.md` の該当 R 節へ追記。primary/fallback の分岐を確定。

### packages/shared（ドメイン型 ― 全レイヤーの前提）

- [x] T022 [P] `packages/shared/src/errors.ts`：`ErrorCode` enum を `contracts/error-codes.md` の 14 種 + 補助コード（`NONCE_INVALID_OR_EXPIRED` / `SIGNATURE_INVALID` / `NOT_CURRENT_OWNER` / `CONTRACT_WALLET_UNSUPPORTED` / `CONDITIONS_HASH_MISMATCH` / `SETTLEMENT_NOT_FINALIZED` / `MANIFEST_SCHEMA_INVALID` / `RATE_LIMITED` / **`POLICY_CONTENT_MISMATCH` / `EXPIRY_MISMATCH`（R-6a・2026-09-05 追加） / `COMMITTED_PARAMS_MISMATCH`（R-2a・2026-09-05 追加） / `MCP_SESSION_MISMATCH`（R-9a・2026-09-05 追加） / `SETTLEMENT_IN_PROGRESS`（R-10・2026-09-06 追加）**）で定義。**安定 ID、改名禁止のコメント**（公開契約）
- [x] T023 [P] `packages/shared/src/hashing.ts`：`resourceHash` / `policyHash` / `conditionsHash` の keccak 実装と `canonicalPath` 正規化（`contracts/eip712-types.md` の R-6 定義どおり）。**あわせて `packages/shared/src/kv-format.ts`**：`share_G` の KEK 暗号フォーマット（`encryptShareG(shareG, kek)` / `decryptShareG(blob, kek)`、AES-256-GCM、バージョンプレフィックス付き）を単一定義。seed の投入（T048/T076）と gateway の読み出し（`kv/shareStore.ts`、T076）が**同じ実装を import する**（フォーマットずれで復号不能になるのを防ぐ、FR-016）
- [x] T024 `packages/shared/src/eip712.ts`：Domain（`TrueCollective` / `1` / `296` / `verifyingContract`）、`RightsReceipt`（17 フィールド、`price` は weibar）/ `KeyGateChallenge` / `OwnerAuthChallenge` の types、`computeReceiptHash()`（EIP-712 `hashStruct`）、`computePurchaseRequestHash()`（T023 依存）
- [x] T025 [P] `packages/shared/src/manifest.ts`：`contracts/rights-manifest.schema.json` の zod スキーマ + 型 + `refine`（`creatorBps + ownerBps === 10000`、`paidAccess.price` が 10^10 weibar の倍数）+ `deriveShareUInfo(assetId)`
- [x] T026 [P] `packages/shared/src/addresses.ts`：`RightsNFT` / `RightsRegistry` アドレス（env 上書き可、デプロイ後に書き戻し）と `abi/` の型 re-export。決済はネイティブ HBAR のためトークンアドレスは無し
- [x] T027 [P] `packages/shared/test/eip712.golden.test.ts`：既知の `ReceiptParams` に対する `computeReceiptHash()` の値を固定（golden）。**Phase 3 の Solidity 側 golden（T030）と同一値**であることの片側（憲章 IV / V、R-6）

### packages/openapi（API 契約の SoT ― gateway / web / agent が共有）

- [x] T028 `packages/openapi/openapi.yaml` を `contracts/gateway-api.md` から起こす（全エンドポイント：`GET /assets`, `GET /assets/:id/preview`, `POST /owner/challenge`, `POST /owner/keygate`, x402 の 402/settle, `POST /keygate/share`, `GET /audit`, `POST /assets/:id/bump-license-epoch`, `POST/GET /mcp`）。リクエスト/レスポンススキーマと `ErrorCode`（§10.1 の 14 + 補助、`packages/shared/errors.ts` を正典として列挙）を定義。`generate` で `src/types.ts` を生成。**以降 gateway / web / agent は API の形をレイヤーごとに手書きせず生成型を import**（FR-029 / SC-012）。※ エンドポイント追加時は `openapi.yaml` を更新（実装とセット）

**Checkpoint**: `packages/shared` build & golden（片側）green、`openapi generate` green、day1 ゲート 4 項目の可否確定。

---

## Phase 3: スマートコントラクト（実装・テスト・デプロイ）— user step 2

**方針**：契約テストを先に red で書き（憲章 IV）、実装 green → Testnet デプロイ → HashScan verify。gateway / web は不要（Hardhat のみ）。

### コントラクトテスト（実装より先に red）

- [x] T029 [P] `apps/contracts/test/RightsNFT.spec.ts`：`mint` で `accessEpoch == 1`、`transferFrom` で `+1`、`_update` 以外に更新経路が無い、`accessEpoch` 単調増加（FR-001）
- [x] T030 [P] `apps/contracts/test/ReceiptLib.golden.t.ts`：`ReceiptLib.hashStruct` の値を固定（golden）。**T027 の TS 側と同一値**をアサート（R-6、憲章 IV）
- [x] T031 [P] `apps/contracts/test/RightsRegistry.settle.spec.ts`：`settleAndIssue{value}` が **1 tx で** ネイティブ HBAR 受領 + `RevenueAllocation` + `ReceiptIssued`、`msg.value != price` で `UNDERPAYMENT` revert、`ReceiptAlreadyIssued` / `BpsInvalid` / `ResourceHashMismatch` / `PolicyHashMismatch` / `ContractWalletUnsupported`
- [x] T032 [P] `apps/contracts/test/RightsRegistry.revenue.spec.ts`：`price = 3333333333333333330`（weibar、10^10 の倍数だが `mulDiv` で端数の出る額）で `creatorAmount + ownerAmount == price`（端数は treasury→creator、dust ゼロ）、`allocationOf` は再移転後も不変（FR-010）、`claim()` が確定額のみ HBAR で払い出し・所有者再解決なし・`nonReentrant`（SC-006 / FR-009）
- [x] T033 [P] `apps/contracts/test/RightsRegistry.consume.spec.ts`：`consume` が `usedCount++` + `ReceiptConsumed` emit、`USE_LIMIT_EXCEEDED` at `maxUses`、`RECEIPT_ALREADY_CONSUMED`（同一 useIndex 2 回）、`hasValidConsumption` の SURVIVE 分岐
- [x] T034 [P] `apps/contracts/test/RightsRegistry.concurrent.spec.ts`：同一 `(receiptHash, 0)` への **20 並列 `consume`** → 成功ちょうど 1・19 が `ReceiptAlreadyConsumed` revert（SC-005 コントラクト層）
- [x] T035 [P] `apps/contracts/test/RightsRegistry.transferMode.spec.ts`：移転後、`INVALIDATE_ON_TRANSFER` の Receipt で `hasValidConsumption` false → `consume` が `LicenseInvalidatedOnTransfer` revert。`SURVIVE_TRANSFER` は移転後も成功。**同一資産に複数 Receipt（SURVIVE 2・INVALIDATE 2、異なる `licensee`）を発行 → 移転 1 回 → SURVIVE 全継続・INVALIDATE 全拒否を一括検証**（spec US3 / Edge Case「大量の利用権」、error-codes #12/#13）
- [x] T036 [P] `apps/contracts/test/RightsRegistry.licenseEpoch.spec.ts`：`bumpLicenseEpoch` で `LicenseEpochBumped` emit、以降 旧 Receipt の `consume` が `LicenseEpochMismatch`（#14）
- [x] T037 [P] `apps/contracts/test/RightsRegistry.fallback.spec.ts`：`payFor{value}(paymentId)` で `pending` 記録、permissionless `finalize` が amount 検証 → allocation + `ReceiptIssued`、timeout 後 `refundUnfinalized` で HBAR 回収（R-2 fallback）
- [x] T038 [P] `apps/contracts/test/adversarial.matrix.spec.ts`：`error-codes.md` の 14 行のうち **contract 層で表現できる全ケース**を 1 スイートに集約（T031–T037 を参照・集約、抜けを補完）
- [x] T039 [P] `packages/shared/test/errorCodes.stability.test.ts`：`ErrorCode` enum の値が `contracts/error-codes.md` の表と **Solidity custom error 名**の両方と一致（改名検知、T044 の後に green）

### コントラクト実装

- [x] T040 [P] `apps/contracts/contracts/interfaces/IRightsNFT.sol` + `IRightsRegistry.sol`：`contracts/solidity-interfaces.md` どおりの関数（`settleAndIssue` は `payable`）・イベント・custom error（`error-codes.md` と一致）
- [x] T041 `apps/contracts/contracts/libraries/ReceiptLib.sol`：`RIGHTS_RECEIPT_TYPEHASH`、`ReceiptParams` struct、`hashStruct(ReceiptParams) → bytes32`（`packages/shared/src/eip712.ts` と完全一致、T030 で検証）。**2026-09-05 R-6a 追加（Critical、Codex #1／Fable C-1 独立一致）**：`policyHash` の内容再導出検証（`price`/`durationSec`〔`= expiresAt - issuedAt`〕/`maxUses`/`permittedAction`/`transferMode`/`creatorBps`/`ownerBps` から再計算した値と `p.policyHash` の一致、`PolicyContentMismatch`）と `expiresAt`/`issuedAt` の整合検証（`ExpiryMismatch`）を `ReceiptLib` のヘルパ関数として実装し、T045 の `settleAndIssue` から呼ぶ
- [x] T042 [P] `apps/contracts/contracts/libraries/PayLib.sol`：`sendValue(address payable to, uint256 amount)`（`.call{value:}` + 失敗 revert）。**HTS / USDC / `0x167` / association は使わない**（R-4 改訂）
- [x] T043 [P] `apps/contracts/contracts/libraries/RevenueLib.sol`：**tinybar 単位**（2026-09-05 R-4 改訂、`msg.value / 1e10` 変換後の値を渡す）の `mulDiv` ベース 2 者按分と端数規則（**余りは `creator` に固定**。`treasury` は導入しない ― 2026-09-06 訂正：T045 の tinybar 会計・creator-only dust 方針と矛盾していたため統一、Codex bounded exec レビュー指摘。SC-006）
- [x] T044 `apps/contracts/contracts/RightsNFT.sol`：ERC-721（OZ 5.x）+ `_accessEpoch` mapping、`_update` override で移転時 +1（`mint` 時 1）、`accessEpoch` / `creatorOf` / `policyHash` / `manifestURI` view、`mint` / `setPolicy`（creator のみ）、`PolicyUpdated` event。**外部 setter を一切作らない**（FR-001）。T029 green
- [x] T045 `apps/contracts/contracts/RightsRegistry.sol`：`ReentrancyGuard` 継承。全 state 変数（`issued` / `usedCount` / `consumed` / `licenseEpoch` / `claimable`〔**tinybar**、2026-09-05 R-4 改訂〕 / `allocationOf` / `pending`）、全 event / custom error、`hasValidConsumption`（INVALIDATE / LICENSE_EPOCH / EXPIRED / USE_LIMIT / ALREADY_CONSUMED の全分岐）、`receiptStatus` / `licenseEpoch` view。`settleAndIssue`（**`payable`**、`solidity-interfaces.md` のステップ：BPS 検証 → `policyHash`/`resourceHash` 照合 → **`policyHash` 内容再導出検証（`PolicyContentMismatch`、R-6a・T041 依存）→ `expiresAt`/`issuedAt` 整合検証（`ExpiryMismatch`、R-6a）** → `licenseEpoch` 一致 → `ownerEpochAtIssue` 検証 → `receiptHash` 計算 → `!issued` → `licensee.code.length==0` → **`priceTinybar = msg.value / 1e10; require(priceTinybar == p.price)`（tinybar 単位比較、R-4 改訂）** → `ownerOf` → `RevenueLib`（tinybar 単位 `mulDiv`、dust は treasury でなく creator へ固定、M-5 対応） → claimable 加算 → `allocationOf` 記録 → issued 保存 → events）、`consume`（**`onlyOperator` 修飾子を追加、2026-09-05 R-3a・Codex #8／Fable H-5 独立一致**）、`claim`（`nonReentrant`、`claimable`〔tinybar〕ゼロ化 → `PayLib.sendValue`〔weibar 換算〕、CEI）、`bumpLicenseEpoch`（creator/admin ガード）。T031–T036 green
- [x] T046 [P] `apps/contracts/contracts/RightsRegistry.sol` に **R-2 フォールバック** `payFor(bytes32 paymentId, bytes32 committedParamsHash) payable` / `finalize(paymentId, params)`（**2026-09-05 R-2a 追加、Codex #2 Critical**：`committedParamsHash := keccak256(abi.encode(p))`（**`ReceiptParams` 全体・`licensee` を含む**。`purchaseRequestHash` は `licensee` を含まないため代用不可 ―別モデルレビューで指摘・licensee 未束縛のまま finalize される穴が残る）を `pending[paymentId]` に固定し、`finalize` はこれと一致する `receiptParams` からのみ収益を確定する。不一致は `CommittedParamsMismatch`。これが無いと誰でも呼べる `finalize` が他人の入金を攻撃者の資産の収益に転用できる） / `refundUnfinalized(paymentId)`（T020 の結果で primary か fallback かを配線）。T037 green

### デプロイ・seed

- [ ] T047 `apps/contracts/scripts/deploy.ts`：`RightsNFT` → `RightsRegistry`（`treasury` / `admin` 注入、トークンアドレス無し）を Testnet へデプロイ、`packages/shared/src/addresses.ts` と `apps/subgraph/subgraph.yaml` の `startBlock` へ書き戻し、**HashScan で verify**。association 不要
- [ ] T048 `apps/contracts/scripts/seed.ts`：デモ用アカウント（creator / owner-A / owner-B / buyer / agent）へ **HBAR を配布**（gas ＋ buyer/agent は決済分）、asset A（`SURVIVE_TRANSFER`、`price = 5 HBAR` = weibar `5000000000000000000`、`maxUses=5`）と asset B（`INVALIDATE_ON_TRANSFER`、`price = 5 HBAR`、`maxUses=3`）をクライアント側 AES-256-GCM 暗号化 → IPFS、Manifest を IPFS、`RightsNFT.mint` で owner-A へ発行。**鍵素材はここでは配布先ストアに入れず**、`apps/contracts/out/seed-artifacts.json`（asset ごとの `contentCID` / `previewCID` / `manifestURI` / 生 `share_G` / 生 `share_U` / `conditionsHash`）と `apps/e2e/.accounts.json` を出力。※ share の KV（KEK 暗号）/ Secrets Store への投入は T076（Phase 7、gateway インフラ完成後）。暗号フォーマットは `packages/shared/src/kv-format.ts`（T023 で作成）を import して使う

**Checkpoint（user step 2 完了）**: 全 contract テスト green（14 行の contract 層分含む、憲章 IV）／`RightsNFT` `RightsRegistry` が Testnet にデプロイ済み・HashScan verify 済み／golden test（Sol ↔ TS）一致。

---

## Phase 4: The Graph Indexer（subgraph 実装・テスト）— user step 3

- [x] T049 [P] `apps/subgraph/schema.graphql`：`contracts/subgraph-schema.md` の全エンティティ（`RightsToken` / `Owner` / `TransferEvent` / `Receipt` / `Consumption` / `RevenueAllocation` / `LicenseEpochChange` / `Claim`）
- [x] T050 `apps/subgraph/subgraph.yaml` + `src/mappings/rightsNft.ts`（`handleTransfer` = `accessEpoch` 履歴 / `Owner` 付替え、`handlePolicyUpdated`）
- [x] T051 `apps/subgraph/src/mappings/rightsRegistry.ts`（`handleReceiptIssued` / `handleReceiptConsumed` / `handleRevenueAllocated`〔金額は weibar〕/ `handleClaimed` / `handleLicenseEpochBumped`）。`subgraph.yaml` に `RightsRegistry` データソース追加
- [x] T052 [P] `apps/subgraph/tests/*.test.ts`：**matchstick-as で fixture イベント → エンティティ生成を unit-test**（各 handler。移転で `RevenueAllocation` の `owner` が付け替わる／`Consumption` が積まれる／`LicenseEpochChange` が記録される）
- [x] T053 `graph codegen && graph build` が通り、`graph test` が全 green

**Checkpoint（user step 3 完了）**: subgraph build 成功、全 handler が matchstick で unit-tested。

---

## Phase 5: CDK / Graph Node インフラ（セットアップ・デプロイ・テスト）— user step 4

- [x] T054 `apps/cdk/lib/graph-node-stack.ts`：EC2 1 台 + Elastic IP + Security Group（graph-node 8000/8020、SSH は自 IP のみ）+ EBS。user-data で `docker compose up`。`apps/cdk/docker/docker-compose.graph-node.yml`（`graph-node` + PostgreSQL + IPFS、`ethereum` provider = `HEDERA_RPC_URL`）。EC2 タイプ / EBS サイズは day1（T021）の記録から決定
- [x] T055 [P] `apps/cdk/test/graph-node-stack.test.ts`：`aws-cdk-lib/assertions` で SG ルール・EBS・EIP・user-data の fine-grained assert + snapshot
- [ ] T056 `pnpm --filter cdk deploy`（`cdk deploy GraphNodeStack`）を AWS へ。EIP / graph-node の `/` health / IPFS を確認。`GRAPH_NODE_HOST` を env・`SUBGRAPH_URL` に反映。**README に「ハッカソン期間のみ稼働、終了後 `cdk destroy`」を明記**
- [ ] T057 `pnpm --filter subgraph deploy`（`graph deploy` を GraphNodeStack の graph-node へ）。`startBlock`（deploy tx）から同期開始 → Hedera relay からブロック取り込みが進み、`_meta { block { number } }` がチェーン先端に追いつくことを確認

**Checkpoint（user step 4 完了）**: Graph Node が AWS で稼働、subgraph デプロイ済み・同期中、GraphQL クエリが返る。

---

## Phase 6: E2E チェックポイント #1（オンチェーン + インデクサ）— user step 5

- [x] T058 `apps/e2e/onchain-indexer.e2e.ts`：**スクリプトレベルの end-to-end**。`deploy` → `seed` → 実 Testnet で owner-A→owner-B transfer / `settleAndIssue{value}`（buyer が直接 or facilitator）/ `consume` / `claim` / `bumpLicenseEpoch` を実行 → **Graph Node が全イベントを正しく index**したことを GraphQL で検証：`RightsToken.accessEpoch` 履歴、`RevenueAllocation` の `owner` が移転後の所有者、`Consumption` の積み上がり、`LicenseEpochChange`、`Claim`。あわせて **SC-006（分配誤差 0）** をオンチェーン残高で一度確認
- [x] T059 `apps/e2e/postman/` に「オンチェーン + subgraph」用の Newman コレクション断片（`SUBGRAPH_URL` への GraphQL クエリのスキーマ検証）を追加し `newman run` green

**Checkpoint（user step 5 = 最初の E2E ゲート）**: **オンチェーン書き込み → インデックス → クエリ** が end-to-end で通る。gateway 着手可。

---

## Phase 7: Gateway（実装・テスト・デプロイ）— user step 6

**方針**：gateway テストを先に red（憲章 IV）→ 依存順に実装 → `wrangler deploy`。KeyGate の `fallback.ts`（T076）を早期に動かし「暗号化パートは常に動く」を担保。

### gateway テスト（実装より先に red）

- [x] T060 [P] `apps/gateway/test/ownerAccess.spec.ts`：`POST /owner/challenge` が nonce 発行、`POST /owner/keygate` 正常系（owner）で `shareG` + `blindedU` + `accessEpochAtGrant` + 所有者セッションクレデンシャルを返す。**`audit_log` に `action='owner_keygate'` / `outcome='allow'` が 1 行記録される**ことを assert（FR-023）
- [x] T061 [P] `apps/gateway/test/ownerAccess.deny.spec.ts`：非所有者 → `NOT_CURRENT_OWNER`、nonce 再利用 → `NONCE_INVALID_OR_EXPIRED`、コントラクトウォレット → `CONTRACT_WALLET_UNSUPPORTED`、別 chainId 署名 → `CHAIN_ID_MISMATCH`
- [x] T062 [P] `apps/gateway/test/transferRevocation.spec.ts`：移転後、旧所有者が **移転前セッション提示** → `OWNER_EPOCH_MISMATCH`（`accessEpoch(tokenId) != accessEpochAtGrant`）。**セッション無し新規要求** → `NOT_CURRENT_OWNER`。新所有者は成功（SC-003 / FR-003 の切り分け）
- [x] T063 [P] `apps/gateway/test/x402.spec.ts`：未払い `GET /assets/:id/paid` が HTTP 402 + `accepts`（`asset` native、`maxAmountRequired` weibar）、`X-PAYMENT` 付き `POST` で settle → `receiptHash` + `serverSignature`、`PAYMENT_ID_PAYLOAD_CONFLICT`（`UNIQUE(payment_id, purchase_request_hash)`）
- [x] T064 [P] `apps/gateway/test/keygateLicensee.spec.ts`：`POST /keygate/share`（licensee）正常系で `useIndex` + `share_G`、`LICENSEE_MISMATCH` / `RECEIPT_EXPIRED` / `RESOURCE_HASH_MISMATCH` / `POLICY_HASH_MISMATCH`。**`consume` 確定後に `share_G` 配信のみ失敗 → 同一 `useIndex` で再取得可（TTL 5 分内）、新規 `consume` は発生しない**（FR-007 / spec Edge Case #1）
- [x] T065 [P] `apps/gateway/test/receiptLock.do.spec.ts`（`@cloudflare/vitest-pool-workers`）：同一 `receiptHash` への **20 並列 `POST /keygate/share`** が DO で直列化 → 成功 1・拒否 19（`RECEIPT_ALREADY_CONSUMED`）・判定 < 3s（SC-005 gateway 層、実並列）
- [x] T066 [P] `apps/gateway/test/transferMode.spec.ts`：`POST /keygate/share` が移転後の `INVALIDATE` Receipt に `LICENSE_INVALIDATED_ON_TRANSFER`、`SURVIVE` には成功、`bumpLicenseEpoch` 後に `LICENSE_EPOCH_MISMATCH`
- [x] T067 [P] `apps/gateway/test/adversarial.matrix.spec.ts` ＋ `apps/gateway/test/audit.spec.ts`：(1) gateway 層で表現される 14 行の全ケース（`CHAIN_ID_MISMATCH` / `PAYMENT_ID_PAYLOAD_CONFLICT` / `LICENSEE_MISMATCH` / `OWNER_EPOCH_MISMATCH` / `NOT_CURRENT_OWNER` / `CONDITIONS_HASH_MISMATCH` / `RATE_LIMITED` ほか）を 1 スイートに集約（Vitest）。(2) **各拒否ケースで `audit_log` に `outcome='deny'` ＋ 対応する `ErrorCode` が記録され、`GET /audit` がその deny 行を返す**ことを検証（FR-023 / 憲章 VI「許可／拒否の判定は監査ログへ記録」）
- [x] T068 [P] `apps/gateway/test/mcpWalletPolicy.spec.ts`：Privy spend policy ― セッション支出上限超過・allowlist 外メソッド呼び出しが拒否される（SC-011）。**2026-09-05 R-9a 追加（Fable H-9）：上限超過リクエストで実際に reject が発火する陽性対照を含めること（policy を設定しただけで「効いている」と扱わない）**。**あわせて `mcp_session_binding` のテスト（R-9a・Fable H-1 対応）を同ファイルに追加**：`buy_access` で発行した `receiptHash` を別の `Mcp-Session-Id` から `decrypt_content` に渡すと `MCP_SESSION_MISMATCH` で拒否されること、同一セッションからは成功すること

### gateway 実装（依存順）

- [x] T069 `apps/gateway/src/index.ts`：Hono app（ルート束ね）+ `ReceiptLock` DO の export、`nodejs_compat` 前提の `viem` import 確認。ハンドラ I/O は `packages/openapi` の生成型（`paths`）で型付け（FR-029）
- [x] T070 [P] `apps/gateway/src/errors.ts`：`ErrorCode → { httpStatus, message }`（`contracts/error-codes.md`、enum は `packages/shared`）、`AppError`、Hono の `onError`。エラー body 型は `openapi` の `components["schemas"]["Error"]` に一致
- [x] T071 [P] `apps/gateway/src/chain/clients.ts`：viem `publicClient`（Hedera relay `http()`）と `walletClient`（`HEDERA_OPERATOR_KEY`、Secrets 経由）
- [x] T072 `apps/gateway/src/chain/reads.ts`：`ownerOf` / `accessEpoch` / `policyHash` / `receiptStatus` / `hasValidConsumption` / `licenseEpoch` の `eth_call` ラッパ（**認可の権威。憲章 II**）
- [x] T073 [P] `apps/gateway/src/chain/writes.ts`：`consume` / `settleAndIssue{value}` / `bumpLicenseEpoch` の tx 送出 + receipt 待ち + revert 理由 → `ErrorCode` マップ
- [x] T074 `apps/gateway/src/db/schema.ts`：drizzle（`wallet_blinded_shares` / `receipt_consumption`〔`UNIQUE(receipt_hash, use_index)`、`status` に復旧ロジック分岐あり、R-3a〕/ `payment_binding`〔**2026-09-05 R-10 改訂：`payment_id` 単独 PK + `status`、旧複合 UNIQUE は撤回**〕/ `auth_nonce` / `mcp_session_binding`〔**2026-09-05 新設、R-9a〕** / `audit_log` / `subgraph_cache`。data-model.md §2.3）
- [x] T075 `apps/gateway/src/db/migrations/` + `db/client.ts`：drizzle-kit で初期マイグレーション、Hyperdrive 経由接続ファクトリ
- [x] T076 [P] `apps/gateway/src/kv/shareStore.ts`（Workers KV `SHARE_G`、`KV_KEK` で AES-GCM。フォーマットは `packages/shared/src/kv-format.ts`〔T023〕を import）＋ `apps/gateway/src/keygate/secrets.ts`（Workers Secrets Store から `share_U` / `RECEIPT_SIGNER_KEY` / `KV_KEK`、メモリ非保持）。**あわせて `apps/gateway/scripts/load-shares.ts`**：T048 の `seed-artifacts.json` を読み、`kv-format.ts` で暗号化した `share_G` を `wrangler kv key put`・`share_U` を `wrangler secret put`（asset ごと）で投入。**実行順**：`wrangler secret put` は Worker が Cloudflare 上に存在している必要があるため、`load-shares.ts` は**空実装の gateway を一度 `wrangler deploy` した後**（＝ T097 の初回デプロイ以降）に実行する。E2E#1（Phase 6）は復号を含まないため share は未投入でよい。※ 開発中の `wrangler dev` は `.dev.vars` で代替
- [x] T077 `apps/gateway/src/keygate/split.ts` + `apps/gateway/src/keygate/fallback.ts`：(1) `blindedU = share_U XOR HKDF-SHA256(sig, info)` の計算・`K` 復元の逆算（`@noble/hashes`）。**2026-09-05 R-1a 追加**：`blindedU` の計算は `wallet_blinded_shares` に既存行が無い場合（＝初回アクセス）のみ実行し、既存行があればそれを再利用する（`KeyGateChallenge` への署名をクライアントに毎回送らせない）。(2) `fallback.ts` ＝ 認可チェック（T072 直読み）通過後に **TTL 付き署名 URL / 復号ストリーム**を返す素の放出経路。KeyGate 本命が動くまでの「暗号化パートは常に動く」保証。**この経路では Gateway が平文/完全鍵を扱うため plan.md Complexity Tracking + README（T125）で開示**
- [x] T078 [P] `apps/gateway/src/auth/verify.ts`（EIP-712 復元アドレス検証、`chainId` 束縛 → `CHAIN_ID_MISMATCH`。**2026-09-05 R-1a 追加**：`OwnerAuthChallenge`（`assetId` 束縛込み、R-11）と `LicenseeAuthChallenge`（新設）の両方を検証できるようにする。`KeyGateChallenge` への署名は認証検証の対象にしない）＋ `auth/nonce.ts`（`auth_nonce` TTL 120s / `chainId=296` / 一度きり → `NONCE_INVALID_OR_EXPIRED`、FR-024）
- [x] T079 [P] `apps/gateway/src/audit/log.ts`：`audit_log` 書き込み（`action` / `outcome` / `subject` / `onchain_ref`、FR-023）
- [x] T080 [P] `apps/gateway/src/middleware/rateLimit.ts` ＋ 全 `routes/` への配線（`RATE_LIMITED`、§9.2。20 並列は許容内）
- [x] T081 `apps/gateway/src/keygate/release.ts`：放出判定を 1 か所に。**owner パス**（(1) セッション提示時 `accessEpoch` 再読でズレ → `OWNER_EPOCH_MISMATCH` 優先、(2) それ以外 `ownerOf == caller` + 署名検証、不一致 → `NOT_CURRENT_OWNER`。**2026-09-05 R-11 追加**：`tokenId` はクライアントから受け取らず `assetId` → Manifest から導出）＋ **licensee パス**（`authSig`〔`LicenseeAuthChallenge`、R-1a〕復元 == `receipt.licensee` → `LICENSEE_MISMATCH`、`hasValidConsumption` を DO 経由）＋ **`conditionsHash` / `resourceHash` / `policyHash` 照合**（→ `CONDITIONS_HASH_MISMATCH` 等）。憲章 II / VI。T077 の `fallback.ts` が先に稼働している前提で本命 `share_G` 放出へ切替
- [x] T082 `apps/gateway/src/receipt/issue.ts`：tx 確定後に EIP-712 Rights Receipt へサーバ署名（`RECEIPT_SIGNER_KEY`、利便クレデンシャル）、licensee 向け `blindedU` を `wallet_blinded_shares`（`path='licensee'`）へ保存
- [x] T083 `apps/gateway/src/do/ReceiptLock.ts` + `apps/gateway/src/do/OperatorTxQueue.ts`（**後者は 2026-09-05 新設、R-3a・Fable H-12 対応**）：
  - `ReceiptLock`：**コールドスタート時（2026-09-06 追加、R-3a 補足・Codex 指摘）**：カウンタを `usedCount` で初期化する**前に** `status='locked'` の孤立行を全件 reconcile（`consumed[receiptHash][useIndex]` を確認し `settled`／`failed` へ補正、未配信の `share_G` があれば配信）してから初期化する。`fetch` で 1 リクエストずつ：T072 直読み検証 → `BEGIN; SELECT ... FOR UPDATE receipt_consumption; use_index := 自前カウンタ.next()（起動時のみ eth_call usedCount で初期化、R-3a）; INSERT (UNIQUE)` → **UNIQUE 衝突時は R-3a の復旧ロジック**（`status='locked'` かつ 60s 超過なら on-chain `consumed` を確認して `settled` 補正 or `failed`＋**同一 `useIndex` で再送**。別 `useIndex` への再採番は不可 ― `maxUses` 境界で支払い済み利用権が失われる、2026-09-06 訂正） → `OperatorTxQueue` へ `consume` 送出を依頼 → 確定後 `status='settled'` → `share_G` 放出（R-3 / gateway-api.md）。**`status='settled'` かつ TTL（5 分）内は同一 `useIndex` への `share_G` 再配信を許容、`consume` は再送しない**（spec Edge Case #1 / FR-007）
  - `OperatorTxQueue`：単一インスタンス（`idFromName("operator")` 固定）。`HEDERA_OPERATOR_KEY` からの tx 送出依頼を受け、nonce（`eth_getTransactionCount`）を自身の storage で逐次採番して送信し、tx hash / revert 理由を呼び出し元（`ReceiptLock`）へ返す。異なる `receiptHash` の `ReceiptLock` が同時に tx を送っても nonce 競合しないことをテストで確認（T065 の並列テストに含める）
- [x] T084 `apps/gateway/src/x402/facilitator.ts`：Blocky402 client（`X402_FACILITATOR_URL` の `/supported` `/verify` `/settle`）。`settleAndIssue{value: price}` への **value 付き ContractCall** ペイロード生成（primary）／ `payFor{value}` + permissionless `finalize`（fallback）。`network: hedera:testnet`、`feePayer`（`0.0.7162784`）は facilitator の応答から
- [x] T085 [P] `apps/gateway/src/graph/cache.ts`：subgraph 補完キャッシュ（`subgraph_cache`、**認可には不使用**、FR-020）
- [x] T086 [P] `apps/gateway/src/routes/preview.ts`：`GET /assets`（subgraph + Manifest 展開）、`GET /assets/:assetId/preview`（認可なし、FR-019）
- [x] T087 `apps/gateway/src/routes/ownerAccess.ts`：`POST /owner/challenge`（T078 の nonce）+ `POST /owner/keygate`（検証 → セッション提示時 `accessEpoch` 再読 → `ownerOf` 直読み → blinding → `share_G` 取得 → 新セッションクレデンシャル発行 → 返却 → 監査）。`gateway-api.md` の 8 ステップ
- [x] T088 `apps/gateway/src/routes/x402.ts`：`x402-hono` middleware（`maxAmountRequired` = Manifest `paidAccess.price`〔weibar〕・`asset` = native〔T020 で確定した表記〕・`payTo` = `RightsRegistry`・`network: hedera:testnet`）、402 応答に Manifest 抜粋、`X-PAYMENT` 受信時の `purchaseRequestHash` 計算 + `payment_binding` INSERT + `settleAndIssue{value}` submit + `ReceiptIssued` 確認
- [x] T089 `apps/gateway/src/routes/keygate.ts`：`POST /keygate/share` を `env.RECEIPT_LOCK.get(idFromName(receiptHash))` へルーティング（licensee パス）。所有者パスは DO を通さず T087
- [x] T090 [P] `apps/gateway/src/routes/graph.ts`（subgraph GraphQL パススルー、FR-020）＋ `apps/gateway/src/routes/audit.ts`（`GET /audit?assetId=&since=`、deny 記録含む、FR-023）
- [x] T091 [P] `apps/gateway/src/routes/admin.ts`：creator 署名で `POST /assets/:id/bump-license-epoch`（緊急失効用）。`chain/writes.ts` の `bumpLicenseEpoch` を呼ぶ

### MCP Server（gateway 相乗り、v1.6）

- [x] T092 `apps/gateway/src/mcp/wallet.ts`：**Privy Server SDK で session signer 初期化 + spend policy**（method allowlist ＝ `RightsRegistry` の決済関数のみ〔`settleAndIssue` / fallback 時 `payFor`〕― ネイティブ HBAR 決済なのでトークン `approve` は不要。1 セッション支出上限〔HBAR 建て、MCP の `Mcp-Session-Id` に統一、R-9a〕、レート制限）。生鍵を Gateway / MCP サーバーが保持しない（FR-028 / SC-011 / R-9）。T068 green
- [x] T093 [P] `apps/gateway/src/mcp/tools/discoverAssets.ts`：`discover_assets`。`graphql-request` で Rights Graph から資産・`manifestURI`・価格・条件（`graph/cache.ts` 再利用、FR-020）
- [x] T094 [P] `apps/gateway/src/mcp/tools/buyAccess.ts`：`buy_access`。`mcp/wallet.ts`（T092）で x402（ネイティブ HBAR）の value 付き署名 → `x402/facilitator.ts` 経由で submit（`apps/web/src/x402/buy.ts` とロジック共有）。spend policy 違反時は明確なエラー（SC-011）。**2026-09-05 R-9a 追加（Fable H-1 対応）**：settle 確定後、`receiptHash` と呼び出し元の `Mcp-Session-Id` を `mcp_session_binding` に記録する
- [x] T095 [P] `apps/gateway/src/mcp/tools/decryptContent.ts`：`decrypt_content`。**2026-09-05 R-9a 追加（Fable H-1 対応、Critical 相当）**：処理開始前に `mcp_session_binding` を引き、渡された `receiptHash` が呼び出し元と同一の `Mcp-Session-Id` で購入されたものであることを確認する（不一致は `MCP_SESSION_MISMATCH`。これが無いと `receiptHash` を subgraph から拾った第三者が他人の購入済みコンテンツを復号できる）。Privy server wallet（T092）で `LicenseeAuthChallenge` に署名して認証（R-1a、鍵導出用 `KeyGateChallenge` 署名は初回のみ）→ `keygate/*` で `K` 復元・復号 → 復号済みデータセットをツール戻り値
- [x] T096 `apps/gateway/src/routes/mcp.ts` + `mcp/server.ts`：`McpServer` に 3 ツール登録、`/mcp`（Streamable HTTP）マウント。Claude Code / Codex から接続できることを確認（FR-026）。**接続用 URL とクライアント設定スニペット（`mcp.json`）を README に**（FR-027）

### デプロイ

- [ ] T097 `pnpm --filter gateway deploy`（`wrangler deploy`。DO / KV / Hyperdrive を本番へ）。**その直後に `load-shares.ts`（T076）を実行**して `share_G` を Workers KV へ・`share_U` を Workers Secrets Store へ投入（asset ごと）→ 反映のため再 `wrangler deploy`。`GATEWAY_URL` を env・`openapi.yaml` の `servers` に反映。MCP server が外部から reachable

**Checkpoint（user step 6 完了）**: 全 gateway Vitest（`@cloudflare/vitest-pool-workers`）green、gateway デプロイ済み、`wrangler dev` と本番の両方で疎通、MCP `tools/list` が返る。

---

## Phase 8: E2E チェックポイント #2（API レイヤー・Newman）— user step 7

- [x] T098 `apps/e2e/postman/gateway.postman_collection.json` を完成：全エンドポイント（preview / owner challenge+keygate / x402 402→settle / keygate/share / audit / bump-license-epoch / mcp `tools/list`）＋ **§10.1 の 14 行の HTTP 断面**。各レスポンスが `packages/openapi/openapi.yaml` のスキーマに適合すること（`code` / HTTP status 一致）を `pm.test` で assert（FR-029 / SC-010）
- [ ] T099 `pnpm --filter e2e test:api`（`newman run`）を **デプロイ済み gateway + 実 Testnet + Graph Node** に対して全 green。owner フロー・licensee フロー（実 HBAR 決済）・14 エラーの HTTP 断面を通す

**Checkpoint（user step 7 = 2 つ目の E2E ゲート）**: 全 API サーフェスが end-to-end で検証済み。web 着手可。

---

## Phase 9: Web（実装・テスト・デプロイ）— user step 8

**方針**：Playwright spec を先に red で用意 → 実装 → `wrangler pages deploy`。web→gateway は `api/client.ts`（openapi 生成型）経由のみ（手書き fetch 型禁止、FR-029 / SC-012）。

### Playwright spec（実装より先に red で用意、実行は Phase 10）

- [x] T100 [P] `apps/web/test/ownerFlow.e2e.ts`：Privy ログイン → Market → "Access as owner" → 復号表示まで **≤ 3 クリック**（SC-008）、実処理時間を `apps/e2e/metrics.json` に（SC-001）
- [x] T101 [P] `apps/web/test/transfer.e2e.ts`：owner-A 閲覧 → 移転 → A 拒否（< 10s）→ owner-B 閲覧成功 → `encryptedContentURI` の CID が不変（US1 シナリオ 4 / FR-015）
- [x] T102 [P] `apps/web/test/buyerFlow.e2e.ts`：非所有者が x402（ネイティブ HBAR）で購入 → 復号 → 閲覧、`maxUses` 内で複数回、支払い開始〜復号を `metrics.json` に（SC-002）
- [x] T103 [P] `apps/web/test/splitScreen.e2e.ts`：1 移転 → 左ペインで旧所有者アクセス拒否（`OWNER_EPOCH_MISMATCH`）、右ペインで `SURVIVE` ライセンス継続を **同時に**観測（US3 シナリオ 3）

### web 実装

- [x] T104 `apps/web/src/main.tsx` / `App.tsx`：`PrivyProvider`（Hedera Testnet chain 設定、embedded EOA）、React Router（`/creator` `/market` `/viewer/:assetId` `/dashboard`）、Tailwind ベース
- [x] T105 `apps/web/src/api/client.ts`（`packages/openapi` 生成型で型付けした Gateway API クライアント、`openapi-fetch`。`baseUrl` = `GATEWAY_URL`）＋ `apps/web/src/chain/hooks.ts`（Privy wallet + viem、`useOwnerOf` / `useAccessEpoch` / `useTransfer`）。**web→gateway は全部このクライアント経由**
- [x] T106 [P] `apps/web/src/graph/queries.ts`：`graphql-request` で Rights Graph をクエリ（資産一覧・Receipt・Allocation。FR-020 の注記付き）
- [x] T107 [P] `apps/web/src/keygate/deriveShareU.ts`（`KeyGateChallenge` 署名 → HKDF-SHA256 → `share_U'`、Web Crypto `deriveBits`）＋ `keygate/decrypt.ts`（`K = share_G XOR share_U'` → AES-256-GCM 復号 → parse）
- [x] T108 [P] `apps/web/src/x402/buy.ts`：`x402-fetch` で `purchaseRequestHash` 計算 → 402 → **ネイティブ HBAR の x402 支払い認可を Privy で署名** → 再送 → `receiptHash` 取得。HBAR 残高不足は明確なエラー
- [x] T109 [P] `apps/web/src/components/`：`RightsBadge` / `EpochTimeline`（`accessEpoch` と `licenseEpoch` を 2 レーン、subgraph の `TransferEvent` / `LicenseEpochChange` から）/ `PricePanel`（価格は weibar → HBAR 表示に整形、期間・回数・permissions を Manifest から、FR-004）/ `SplitScreen`（左＝旧所有者 `OWNER_EPOCH_MISMATCH`、右＝`SURVIVE` 継続復号、§13.1 の 30–45 秒）/ `AttackCounter`（Concurrent Replay の「1 settled / 19 rejected」ライブ表示、§13.1 の 2:30）
- [x] T110 `apps/web/src/routes/Creator.tsx`：データセットアップロード → クライアント側暗号化（`keygate/` 再利用）→ Manifest 作成（`packages/shared/manifest.ts` で検証）→ `RightsNFT.mint`（Privy 署名）
- [x] T111 `apps/web/src/routes/Market.tsx`：資産一覧（`GET /assets`）・プレビュー・"Access as owner"・x402 購入フロー（`PricePanel` + `x402/buy.ts`）
- [x] T112 `apps/web/src/routes/Viewer.tsx`：所有者パス（challenge → 署名 → `/owner/keygate` → 復号 → 表示）＋ licensee パス（`/keygate/share` → `useIndex` 表示 → 復号 → 残回数）。`RightsBadge` / `EpochTimeline` 反映
- [x] T113 `apps/web/src/routes/Dashboard.tsx`：Rights Graph 監査ビュー（`RightsToken` の `transfers` / `receipts` / `allocations`、`contracts/subgraph-schema.md` のクエリ）＋ `AttackCounter` ＋ `GET /audit` の拒否ログビュー
- [x] T114 [P] `apps/web/test/*.test.ts`：Vitest でコンポーネント・hooks のユニットテスト
- [ ] T115 `pnpm --filter web deploy`（`wrangler pages deploy dist`）。`GATEWAY_URL` / `SUBGRAPH_URL` を本番設定

**Checkpoint（user step 8 完了）**: web デプロイ済み、web unit テスト green。

---

## Phase 10: E2E チェックポイント #3（画面操作込み・Playwright）— user step 9

- [x] T116 [P] `apps/e2e/attacks.e2e.ts`：**Concurrent Replay（実 20 並列、SC-005）** / Chain ID Spoofing（単一デプロイ・署名の `chainId` だけ誤らせる）/ Cross-Resource（asset A の Receipt で asset B）をブラウザ + スクリプトから実行し、ライブ拒否を確認。`AttackCounter` の表示も検証
- [x] T117 `apps/e2e/metrics.ts`：SC-001 / SC-002 / SC-003 / SC-005 のレイテンシ分布を集計 → `metrics.json`（p50 / p95 のしきい値判定）。SC-005 は「アプリ層の拒否 19 件 < 3s」と「成功 1 件の on-chain 確定」を分けて記録
- [x] T118 `apps/e2e/demo-3min.e2e.ts`：`quickstart.md` §2 の 3 分デモ台本を Playwright で**自動通し**（納品契約の自動検証）
- [ ] T119 T100–T103（web spec）＋ T116 / T118 を **実デプロイ（web + gateway + Graph Node + Testnet）** に対して全 green。SC-001/002/003/005/008 の数値がしきい値内

**Checkpoint（user step 9 = 3 つ目の E2E ゲート）**: 画面操作込みの full E2E が green。二層 epoch の並置デモ・攻撃のライブ拒否が画面で実演できる。

---

## Phase 11: Agent（実装・テスト）— user step 10

- [x] T120 `apps/agent/src/mcpClient.ts` + `apps/agent/src/analyze.ts`：自前 MCP クライアントで デプロイ済み gateway の `/mcp` へ接続し 3 ツールを `discover_assets → buy_access → decrypt_content` の順で呼び、Claude tool-use（`answer`）で分析回答、`apps/agent/out/answer.json` 出力（`--question` 引数、人手介入 0）
- [x] T121 `apps/agent/test/autonomous.spec.ts`：`discover_assets → buy_access → decrypt_content → analyze` を **人手介入 0** で完走（実推論・実 HBAR 決済〔Blocky402〕・実 KeyGate、SC-007 / SC-009）。本番の AI エージェント実行体（Claude Code / Codex）を CI で起動できないための代替検証ハーネス（v1.6）

**Checkpoint（user step 10 完了）**: agent 自律フローが デプロイ済み MCP server に対して green。ドッグフーディング（開発に使う Claude Code / Codex から実 `/mcp` 接続）でデモ準備完了。

---

## Phase 12: ドキュメント & 提出物 — user step 11

- [ ] T122 `scripts/audit-no-mocks.sh` の最終 pass：コア経路（`apps/gateway/src/chain` / `apps/gateway/src/keygate/release.ts` / `apps/gateway/src/x402` / `apps/gateway/src/mcp/tools` / `apps/agent/src/analyze.ts`）に mock / stub / ハードコード応答が無いこと（SC-009）。※ script 自体は T017 で CI に載せ済み
- [x] T123 [P] `README.md`：**信頼モデル段落**（owner パスの `share_U` を Gateway が再取得可能＝憲章 VI 残存信頼点、KeyGate fallback 経路が有効な間は Gateway が平文/完全鍵を扱う、Gateway 可用性の単一障害点、R-2 primary 不成立時の非 trustless フォールバック、MCP 決済ウォレットは Privy policy で上限制約＝生鍵は非保持だが公開エンドポイント、**決済資産はネイティブ HBAR**〔Blocky402 の対応制約〕、Rights Graph は `apps/cdk` の AWS EC2 でハッカソン期間のみ自前ホスト）。**事前作業の明示開示**：`hedra-sample`（公開の汎用ボイラーテンプレート）／`specs/` `.specify/`（2026-09-02〜03 作成の設計・spec。ETHOnline の AI ポリシーに準拠）／`.claude/` 設定。AI ツール利用（Claude Code / Codex）と Git 履歴（実装コミットは 2026-09-04 以降）。**Graph Node の エンドポイントと `cdk destroy` 手順**（憲章 VII / DoD #7）
- [ ] T124 [P] `quickstart.md` の DoD チェック表（§3）を全項目 ✅ にする最終確認
- [ ] T125 [P] `pnpm run check` を全 green：`biome ci` / `knip` / `jscpd` / `tsc --noEmit` / `redocly lint openapi.yaml` / `openapi.yaml` が実装と一致（生成型で `tsc` green）/ `newman run` 全 assert green
- [ ] T126 [P] 提出物：Showcase 記述、**partner prize 3 枠の要件充足確認** ―（a）Hedera「AI & Agentic Payments」＝ x402 ゲート付きサービスを Hedera Testnet で実ホスト・**Blocky402 facilitator 経由**・実有料リクエスト（ネイティブ HBAR）end-to-end・HashScan で `RightsNFT`/`RightsRegistry` verify・README にセットアップ/アーキ/支払いフロー、（b）Privy「Best Financial Flow」＝ Privy ウォレットを中核に x402（ネイティブ HBAR）決済フローが完結、（c）Privy「Best B2B Financial Product」＝ MCP 決済ウォレットに Privy control（session signer + spend policy）。**From Scratch 自己監査**：全 TrueCollective 固有ファイルの初回コミットが 2026-09-04 以降であることを `git log` で確認。**The Graph は submit しない**
- [ ] T127 [P] `docs/demo-video/`：**提出動画（2〜4 分）を規定準拠で制作**。720p 以上／話者ナレーション（TTS・AI 音声禁止）／速度操作なし／スマホ録画不可／スライドは箇条書き 4 点以内・イントロ 20 秒以内／冒頭 30 秒で WOW。**Phase 6 / 8 / 10 の E2E ゲート通過時点で該当区間を分割収録**し 09-12 にまとめる。**審査員のライブ MCP 接続区間は事前録画**
- [x] T128 [P] `specs/001-rights-runtime-mvp/pitch/qa.md`：**ライブ審査 Q&A 想定問答**（9 問）：①なぜサブスク API でなくオンチェーンか（＝原子的な権利状態の切替）②Gateway が握るもの（Receipt 署名鍵／owner `share_U`／settlement 観測）と本番の分散化 ③R-2 fallback（非原子でも HBAR 非 custody、permissionless finalize、timeout 返金）④Rights Graph は load-bearing か（Agent の discover 依存、`apps/cdk` の AWS EC2 で自前ホスト、Mirror Node は最終手段）⑤並行性の証明（DO 直列化 + DB UNIQUE + オンチェーン `consume` の 3 層、実 20 並列）⑥「復号後は右クリック保存できる」→ 主張は静的データのコピー防止ではなく権利状態の同期 ⑦owner path の `share_U` 残存信頼点（正直に + Shamir 2-of-3 計画）⑧コントラクトウォレット/ERC-1271 非対応 ⑨「x402 を安全にしたのか」→ Rights Gateway の request-binding/idempotency/settle-before-release/並行制御を実装した
- [ ] T129 本番デプロイの最終確認：gateway（`wrangler deploy`）/ web（`wrangler pages deploy`）/ Graph Node（`cdk deploy` 済み）が全て本番稼働。`mcp.json` が README に。HashScan verify 済み。3 分デモ台本を通しで 1 回

**Checkpoint（user step 11 完了）**: 提出可能。DoD §20 の 7 項目を満たす。

---

## Dependencies & Execution Order

### レイヤー間の順序（厳守）

```
Phase 1 基盤 ─→ Phase 2 共有基盤 & day1 ゲート ─→ Phase 3 コントラクト
  ─→ Phase 4 subgraph ─→ Phase 5 CDK/Graph Node ─→ Phase 6 E2E#1（オンチェーン+インデクサ）
  ─→ Phase 7 gateway ─→ Phase 8 E2E#2（API/Newman）
  ─→ Phase 9 web ─→ Phase 10 E2E#3（画面操作込み）
  ─→ Phase 11 agent ─→ Phase 12 ドキュメント
```

- **各 E2E ゲート（Phase 6 / 8 / 10）を通過するまで次のレイヤーに着手しない。**
- day1 ゲート（T018–T021）は Phase 2 の最優先。primary/fallback の分岐がここで決まる。
- Phase 3 は Phase 2 の `packages/shared`（特に `eip712.ts` / `hashing.ts`）と golden test に依存。
- Phase 4/5 は Phase 3 のデプロイ済みアドレス・ABI・`startBlock` に依存。
- Phase 7 は Phase 6（＝オンチェーン + Graph Node が動くこと）＋ Phase 2 の `openapi.yaml` に依存。
- Phase 9 は Phase 8（＝API が動くこと）＋ `openapi` 生成型に依存。
- Phase 11 は Phase 7 のデプロイ済み MCP server ＋ Phase 8 通過に依存。

### レイヤー内の順序

- **テスト先行（憲章 IV、NON-NEGOTIABLE）**：各ビルド Phase（3 / 7 / 9）は「テスト（red）→ 実装（green）」。14 エラーマトリクスは contract 層（Phase 3）と gateway 層（Phase 7）に分けて先に書く。
- contracts: interface → library（ReceiptLib / PayLib / RevenueLib）→ RightsNFT → RightsRegistry → fallback → deploy → seed
- subgraph: schema → mappings → matchstick unit test → build
- gateway: `chain/reads`（認可の権威）→ db / kv / secrets → keygate（`fallback.ts` を先に）→ auth → route → DO → mcp → deploy
- web: `api/client`（openapi 型）→ hooks / graph / keygate → components → routes → deploy

### 並行機会（2 人 + Claude Code / Codex）

| 期間 | Dev-1（権威コア） | Dev-2（プロダクト面・インフラ） |
|---|---|---|
| Phase 1–2 | `packages/shared`（T022–T027）、day1 T018–T020 | `packages/openapi`（T028）、`apps/cdk` scaffold、day1 T021 |
| Phase 3 | コントラクト全部（テスト → 実装 → deploy/seed） | Phase 4 subgraph（schema / mappings / matchstick）を先行着手（contracts の event 定義が固まり次第）＋ Phase 5 CDK stack（T054/T055） |
| Phase 5–6 | Phase 6 E2E#1 スクリプト（T058） | `cdk deploy` + `graph deploy`（T056/T057） |
| Phase 7 | gateway の `chain/` `keygate/` `x402/` `do/` `auth/` + テスト（T060–T067, T069–T084） | gateway の `routes/` + `src/mcp/`（Privy wallet 含む、T085–T096）＋ Phase 8 Postman コレクション |
| Phase 8 | E2E#2 の owner/licensee フロー確認 | Newman コレクション完成（T098）、web components 先行着手 |
| Phase 9 | web の keygate / x402 / hooks（T105–T108） | web の routes / components / Dashboard（T104, T109–T113）＋ Playwright spec |
| Phase 10–12 | E2E#3（T116–T119）、agent（T120–T121） | README / 動画 / Q&A / 提出物（T123–T129） |

- `receiptHash` のクロスレイヤー一致（憲章 V）は **Dev-1 が単独で握る**。`packages/shared` の `eip712.ts` / `hashing.ts` を Dev-2 が直接編集しない。
- `packages/openapi/openapi.yaml` は HTTP API のクロスチーム契約（Dev-2 主導）。`ErrorCode` は `packages/shared/errors.ts` を正典として列挙のみ（T039 で一致検証）。
- 各タスク（または論理グループ）を 1 サブエージェントに割り当て、`contracts/*.md` の該当契約と `.claude/rules/*` をプロンプトへ再掲（親コンテキストを膨らませない、`.claude/rules/development.md`）。並行起動は 2〜3 個まで、原則逐次。
- worktree 分離で 2 名 × 複数 AI セッションの衝突を回避（`superpowers:using-git-worktrees`）。

---

## Implementation Strategy

### 9 日スケジュール骨子（2026-09-04〜09-13、提出 09-13 12:00 EDT ＝ 09-14 01:00 JST）

| 日 | 内容 |
|---|---|
| 09-04 | Phase 1 基盤 ＋ **Phase 2 の day1 ゲート T018–T021 ＝ hard gate**（R-2〔Blocky402 が value 付き ContractCall を扱えるか〕/ MCP on Workers / ネイティブ HBAR value / CDK Graph Node の可否を終業までに確定）|
| 09-05 | Phase 2 残り（`packages/shared` + `openapi.yaml`）＋ Phase 3 コントラクトテスト（red）＋ 実装着手 |
| 09-06 | Phase 3 コントラクト実装 green → deploy → HashScan verify。並行で Dev-2 が Phase 4 subgraph |
| 09-07 | Phase 5 CDK deploy + subgraph deploy → **Phase 6 E2E#1（オンチェーン + インデクサ）＝ 第 1 ゲート**。動画の「NFT 移転で収益付替え」区間を収録 |
| 09-08 | Phase 7 gateway テスト（red）＋ 実装（両 dev、最大の山）|
| 09-09 | Phase 7 gateway 実装 green → `wrangler deploy` → **Phase 8 E2E#2（API/Newman）＝ 第 2 ゲート**。動画の「x402 購入 → 復号 → 分配」区間を収録 |
| 09-10 | Phase 9 web 実装（両 dev）|
| 09-11 | Phase 9 web deploy → **Phase 10 E2E#3（画面操作込み）＝ 第 3 ゲート**。動画の「二層 epoch 並置 / 攻撃のライブ拒否」区間を収録 |
| 09-12 | Phase 11 agent ＋ Phase 12 ドキュメント・提出動画まとめ・提出物・`pnpm run check` green。**「実装日」ではなく「提出日」として死守** |
| 09-13 AM | 最終提出（12:00 EDT 前）|

### スコープ tripwire（レイヤーは切らず、深さを切る）

いずれも README の信頼モデル段落（T123）で開示すること（憲章 VII）。

| 判定タイミング | 症状 | 落とす深さ | 成立 |
|---|---|---|---|
| 09-04 終業（T020） | Blocky402 が value 付き ContractCall 決済（R-2 primary）を扱えず plain native transfer のみ | `payFor` + permissionless `RightsRegistry.finalize` / `refundUnfinalized` fallback（非原子・HBAR は非 custody）へ。T046 / T084 を fallback 配線で確定 | Phase 7 の x402 成立（「決済と anchor は非原子」を開示）|
| 09-04 終業（T021） | CDK の Graph Node が Hedera relay と同期しない / EC2 リソース不足 | インスタンスを 1 段上げて再 `cdk deploy`。それでも不安定なら Dashboard は `subgraph_cache`（`apps/gateway/src/graph/cache.ts`）＋ Hedera Mirror Node フォールバック表示に切替 | Phase 6 E2E#1 は「オンチェーン検証」を主にし、subgraph は best-effort。Rights Graph は発見・監査のみ（認可には不使用）|
| Phase 7（09-08） | KeyGate 本命（`share_G` XOR）が green にならない | `apps/gateway/src/keygate/fallback.ts`（T077）に固定＝Gateway が短命署名 URL を返す素の方式 | Phase 7 成立（「この経路では Gateway が平文を扱う」を開示）|
| Phase 10（09-11） | オンチェーン 20 並列 `consume`（T034）がデモ環境で不安定 | `AttackCounter`（T109）は Durable Object 層の拒否を主表示。T034 の contract テスト結果を証拠として併記 | Phase 10 成立（オンチェーン最終権威の証明はテストで担保）|
| Phase 12（09-12） | 審査員が自環境から MCP 接続（`decrypt_content` 等）に失敗しやすい | その区間だけ事前録画。ライブは接続済み環境でデモし「URL を貼れば繋がる」招待に留める | WOW 成立 |

### Definition of Done（`docs/idea.md` §20）へのマッピング

| DoD | タスク |
|---|---|
| 2. Ethereum（Hedera）の必然性 | T044（`_update` のみ）/ T045（権利 anchor ＝ 決済 tx、primary 不成立時は `finalize`） |
| 4. 実装が本物 | T017 + T122（no-mocks 監査）/ T017（CI 実 Testnet + `newman run`）/ T028 + T098–T099（OpenAPI SoT ＋ 実デプロイに対する API 契約テスト、FR-029）/ Phase 6/8/10 の 3 つの E2E ゲート |
| 5. 攻撃に耐える | T038（contract 14 行）/ T067（gateway 14 行）/ T034・T065・T116（Concurrent Replay 実 20 並列） |
| 6. Sponsor 統合が深い（submit 3 枠）| Hedera「AI & Agentic Payments」＝ T020（Blocky402）・T045・T084・T088／ Privy「Best Financial Flow」＝ T104・T108／ Privy「Best B2B Financial Product」＝ T092（session signer + spend policy）。The Graph は submit しない（Rights Graph は Phase 4–6 で技術要素として維持、ホスティングは `apps/cdk`）|
| 7. 提出が透明 | T123（信頼モデル + 事前作業開示）/ T126（From Scratch 自己監査）/ T127（規定準拠の動画）/ T128（Q&A）|

---

## Notes

- `[P]` = 別ファイル・依存なし
- 実装前にテストの失敗（red）を必ず確認（憲章 IV）
- **各 Phase の Checkpoint で停止**し、そのレイヤー単独 → E2E ゲートの順で検証してから次へ
- タスクごと（または論理グループごと）にコミット
- 避ける：レイヤーをまたいだ先行着手（E2E ゲート未通過で次レイヤーを始める）、曖昧なタスク、同一ファイルの競合
