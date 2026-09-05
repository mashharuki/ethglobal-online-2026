# 実装計画: Transfer-Coupled Rights Runtime MVP

**Branch**: `001-rights-runtime-mvp` | **Date**: 2026-09-02 | **Spec**: [spec.md](./spec.md)

**Input**: `specs/001-rights-runtime-mvp/spec.md` ／ 正典 `docs/idea.md` v1.8 ／ 憲章 `.specify/memory/constitution.md` v1.3.0

---

## Summary

NFT の所有権と「実際の利用権・将来収益」を同期させる **transfer-coupled rights runtime** を、ETHOnline 2026 向け MVP として Hedera Testnet 上に構築する。

- **中心命題**：**Owner Epoch**（所有者特権、NFT 移転で自動 +1。実装名は `RightsNFT.accessEpoch(tokenId)`、Receipt 束縛は `ownerEpochAtIssue`）と **License Epoch**（購入者特権、ポリシー更新でのみ更新。実装名は `RightsRegistry.licenseEpoch(tokenId)`）を分離管理し、NFT 移転時にアクセス・ライセンス・将来収益をそれぞれ定義済みルールで更新する。用語は spec.md「用語の対応（正典）」に従う。
- **技術アプローチ**：
  - **Smart Contract 層**（Solidity 0.8.34 / Hedera Testnet）：`RightsNFT`（ERC-721 + `accessEpoch`）と `RightsRegistry`（x402 決済の原子的 settlement ＋ Receipt ライフサイクル ＋ 収益 vault）。
  - **Backend 層**（Access Gateway、TypeScript / Node）：所有権のオンチェーン直読み認可、x402 ゲート、KeyGate（`share_G` の放出判定）、Receipt 消費の原子的処理、監査ログ、Rights Graph 供給用インデクサ。
  - **Frontend 層**（React / Vite / Privy）：Creator Console、Marketplace / Viewer（KeyGate クライアント側復号）、Rights Graph Dashboard（審査員向け 2 分割デモ画面を含む）。
  - **AI Agent**（自律クライアント）：subgraph で発見 → x402 購入 → KeyGate 復号 → データセットへの分析回答（実 LLM 推論）。
  - **Rights Graph subgraph**（自前 Graph Node on Hedera Testnet）：`Transfer` / `ReceiptIssued` / `ReceiptConsumed` / `RevenueAllocated` を index。発見・監査のみ、認可には使わない。Hedera が Subgraph Studio 非対応のため自前ホスト、Graph の賞トラックには submit しない（R-5）。
- **勝ち筋**：正常系の幅ではなく「権利状態の *変化*」（移転 → 失効／存続の並置、攻撃のライブ拒否）を見せる。§10.1 の 14 攻撃ケースと §10.4 の成功基準を受け入れテストとする。

---

## Technical Context

**Language/Version**:
- Contracts: Solidity `0.8.34`（Hedera EVM = Cancun 相当。blob/Type-3 tx は不可、それ以外は Cancun opcode 利用可）
- Backend / Agent / Subgraph mappings: TypeScript `5.6+`。Backend は Cloudflare Workers runtime（`workerd`）、Agent は Node.js `22 LTS`
- Frontend: TypeScript + React `18`

**モノレポ / 共通ツールチェーン**:
- **pnpm workspace**（`pnpm-workspace.yaml` の globs = `apps/*` + `packages/*`）＋ **Turborepo**（`turbo.json`：build / lint / test / typecheck のタスクグラフ）。デプロイ可能な成果物（contracts / gateway / web / subgraph / agent / e2e）と AWS インフラ（`apps/cdk` ＝ self-hosted Graph Node、ハッカソン期間のみ）はすべて `apps/` 配下、レイヤー共有は `packages/shared`、**Access Gateway HTTP API の単一の真実源は `packages/openapi`（`openapi.yaml` + `openapi-typescript` 生成型）**
- **`packages/openapi`（API 契約の SoT）**：`openapi.yaml`（OpenAPI 3.1）を唯一の API 定義とし、`openapi-typescript` で `src/types.ts` を生成。`apps/gateway`（Hono のハンドラ I/O 型付け）と `apps/web` / `apps/agent`（fetch 呼び出しの型付け）が同一の生成型を import → **フロント/バックの API 型ズレをビルド時に検知**。`redocly lint` を CI ゲートに（FR-029）
- **Biome**（`biome.json`、ルート 1 ファイル）：lint + format を全 workspace 一括。ESLint/Prettier は使わない（`.claude/rules/code-style.md` の const-first・`type` vs `interface`・`satisfies` を lint ルールで補助）
- **knip**（`knip.json`）：未使用ファイル・未使用 export・未使用 dependency をモノレポ横断で検出。CI で fail
- **jscpd**（`.jscpd.json`）：コード重複（copy-paste）検出。`packages/shared` にまとめるべき重複を早期発見
- **Vitest**（`vitest.workspace.ts`、ルート）：`apps/gateway` / `apps/web` / `apps/agent` / `packages/shared` のユニット・統合テスト
- **Playwright**：`apps/e2e`（`apps/web` の ブラウザ E2E ＝所有者フロー ≤ 3 クリック、3 分デモ台本の通し、Concurrent Replay）
- **Postman + Newman**：`apps/e2e/postman/`（Access Gateway API の E2E。`newman run` を CI ジョブ＋デモ前チェックで実行、レスポンスは `packages/openapi` のスキーマに適合を assert。FR-029 / SC-010）

**Primary Dependencies（レイヤー別）**:
- **Contracts**: Hardhat `3.x` + `@nomicfoundation/hardhat-toolbox-mocha-ethers` + `@nomicfoundation/hardhat-verify`（`hedra-sample` と同一構成）、OpenZeppelin Contracts `5.x`（`ReentrancyGuard` / `Address.sendValue`）。**決済資産はネイティブ HBAR**：`settleAndIssue` は `payable`、収益は `msg.value` を分配、`claim` / `refundUnfinalized` は `.call{value:}` で払い出し。HTS / USDC / `0x167` は不使用（R-4 改訂）。契約テストのみ Hardhat runner（mocha/chai）＋ 任意で Foundry fuzz。※ Vitest は非コントラクト層に使用
- **API 契約**: **`packages/openapi`**（`openapi.yaml` = OpenAPI 3.1 の単一定義、`openapi-typescript` で型生成、`@redocly/cli` で lint）。gateway / web / agent がここから型を取る（FR-029）
- **Backend（Access Gateway）**: **Hono `4`**（`hono` + `@hono/node-server` はローカル、本番は `workerd`）+ **`x402-hono`**、**Cloudflare Workers**（`wrangler` でデプロイ）、**Durable Objects**（receiptHash ごとの consume 直列化 = 「exactly-1」保証、R-3）、**Hyperdrive** 経由の **PostgreSQL**（`postgres` / `drizzle-orm`、`SELECT ... FOR UPDATE` 可）、**Workers KV**（`share_G` 暗号化保管）、**Workers Secrets Store**（`share_U` / 署名鍵 / KEK）、`viem` `2.x`（Hedera JSON-RPC relay 直読み）、`@noble/hashes` / `@noble/curves`、`zod`、**`@truenft/openapi`**（`openapi.yaml` 由来の生成型でハンドラ I/O を型付け）
- **Frontend**: **Vite `5`** + React `18` + **Tailwind CSS `4`**（`@tailwindcss/vite` プラグイン、`tailwind.config` は最小）、`@privy-io/react-auth`（内蔵 EOA ウォレット）、`viem`、`x402-fetch`、`graphql-request`（Rights Graph クエリ）、Web Crypto API（AES-256-GCM 復号・HKDF）、**`@truenft/openapi`**（gateway 呼び出しの型付け。`openapi-fetch` 等の型安全クライアントを使ってよい）
- **Privy server wallet（MCP 決済ウォレット、R-9）**: Privy Server SDK（`@privy-io/server-auth` 等）。MCP の `buy_access` が使う決済ウォレットを **session signer + spend policy**（1 セッション上限額（HBAR 建て）、`RightsRegistry` の決済関数のみの method allowlist ＝ ネイティブ決済なのでトークン `approve` は不要、レート制限）で管理。生鍵を Gateway / MCP サーバーが保持しない（憲章 VI / FR-028）
- **MCP Server（v1.6）**: `@modelcontextprotocol/sdk`（Streamable HTTP transport）を **gateway と同一 Cloudflare Workers 上に相乗り**させ、`discover_assets` / `buy_access` / `decrypt_content` の3ツールを公開。`x402-fetch` 相当の処理 + `viem` + `graphql-request` + `packages/shared`（KeyGate 導出・復号）。決済は上記 Privy server wallet で署名（Workers Secrets Store に生鍵を置かない）
- **Agent CI Harness（v1.6・自動検証専用、旧 Agent の後継）**: `@anthropic-ai/sdk`（Claude、実推論）+ 自前 MCP クライアントで上記3ツールを呼び出し、`discover → purchase → decrypt → analyze` を人手0で自動検証（SC-007/SC-009）。Node.js の通常プロセス（本番の自律実行体ではなく CI 専用）
- **Subgraph（自前 Graph Node）**: `@graphprotocol/graph-cli` / `graph-ts`、GraphQL（`schema.graphql`）、`specVersion 0.0.4` / `apiVersion 0.0.6`、**Hedera Testnet 対応の自前ホスト Graph Node**（`hedra-sample/hedera-subgraph-example` 準拠）。デプロイ先は **AWS 上に AWS CDK でプロビジョニングした EC2 1 台 + docker-compose**（`apps/cdk/`、ハッカソン期間のみ）。Hedera は Subgraph Studio / Hosted Service / The Graph Market に非対応のため。**The Graph の賞トラックには submit しない**（発見・監査の技術要素として維持、R-5）
- **AWS CDK（`apps/cdk/`、ハッカソン期間のみの一時インフラ）**: `aws-cdk-lib` `2.x` / `constructs`（TypeScript）。self-hosted Graph Node の 3 コンテナ（`graph-node` + PostgreSQL + IPFS）を **EC2 1 台 + docker-compose** で起動する単一 Stack（EC2 + Elastic IP + Security Group + EBS、user-data で `docker compose up`。Hedera JSON-RPC relay を `ethereum` provider に設定）。ハッカソン終了後は `cdk destroy` で撤去。CI/CD では回さず手動 `cdk deploy`
- **x402 facilitator**: **Blocky402**（BlockyDevs の OSS x402 facilitator、Hedera Testnet V1 対応、API キー不要）— または自前 facilitator を CF Workers 上に（研究課題 R-2）

**Storage**:
- **オンチェーン（Hedera Testnet）が権威**：所有権 / `accessEpoch` / `licenseEpoch` / Receipt 状態 / `RevenueAllocation` / claimable 残高
- **PostgreSQL（Hyperdrive 経由、Access Gateway、非権威）**：`payment_binding`（`UNIQUE(payment_id, purchase_request_hash)`）、`receipt_consumption`（`UNIQUE(receipt_hash, use_index)`、defense-in-depth）、`wallet_blinded_shares`、`auth_nonce`、`audit_log`、`subgraph_cache`
- **Durable Objects（Access Gateway）**：`ReceiptLock` DO（`idFromName(receiptHash)`）が同一 Receipt への consume を単一スレッドで直列化 → 「exactly-1」の第一権威をアプリ層で担保（R-3。憲章の「原子的スクリプト」に相当）。オンチェーン `consume` が最終権威
- **Workers KV（Access Gateway）**：`asset_key_shares`（`share_G` を KEK 暗号化して保管）
- **Workers Secrets Store（DB の外）**：`share_U`（asset ごと）、EIP-712 Receipt 署名鍵、KV 暗号化 KEK、`HEDERA_OPERATOR_KEY`（Gateway の `consume` / デプロイ用）。**MCP の x402 決済ウォレットの鍵はここに置かず、Privy server wallet（session signer + policy、R-9）で管理**
- **暗号化コンテンツ**：IPFS（`web3.storage` 等）に暗号文のみ。公開プレビューは同 CID か別 URI

**Testing**:
- Contracts: Hardhat（mocha/chai/ethers）＋ 任意で Foundry（`forge` 1.5、fuzz による攻撃マトリクス）。§10.1 の 14 行のうち contract 層で表現できるもの（`RightsRegistry.settle/revenue/consume/concurrent/transferMode/licenseEpoch/fallback` の各 spec）と RightsNFT の主要ハッピーパスを **contract 実装より前に**書く（憲章 IV、tasks.md Phase 3 の「テスト先行」節）。gateway 層の 14 行は Phase 7 で同様に先行
- Backend: **Vitest**（`@cloudflare/vitest-pool-workers` で Workers runtime 上のユニット・DO テスト）＋ Hedera Testnet 実接続の統合テスト（`wrangler dev` + `miniflare`）
- Frontend: **Vitest** ＋ **Playwright**（所有者フロー ≤ 3 クリック、SC-008）
- **API E2E**: **Postman コレクション + Newman**（`apps/e2e/postman/`、CLI は `newman run`）。Access Gateway の全エンドポイント（発見・所有者パス・x402・keygate/share・audit）と §10.1 の 14 行の HTTP 断面を、実デプロイ済み gateway + 実 Hedera Testnet に対して実行。**各レスポンスが `packages/openapi/openapi.yaml` のスキーマに適合することを assert**（契約ドリフト検知）。CI ジョブとデモ前チェックの双方で実行（FR-029 / SC-010）
- E2E（ブラウザ）: **Playwright** ＋ Agent スクリプト（SC-007 / SC-009）、Concurrent Replay は実 20 並列（SC-005、憲章 IV）
- Golden: EIP-712 `receiptHash` の Solidity（Hardhat）↔ TypeScript（Vitest）一致（R-6）
- 契約: `packages/openapi/openapi.yaml` を single source of truth とし、`openapi-typescript` で型生成。`apps/gateway`（リクエスト/レスポンスの型付け）と `apps/web` / `apps/agent`（クライアント呼び出しの型付け）が同一の生成型を import → フロント/バックの API 型ズレをビルド時に検知（FR-029）
- 品質ゲート（CI）: `biome ci` / `knip` / `jscpd` / `tsc --noEmit`（全 workspace）／ `redocly lint openapi.yaml` ／ `newman run`

**Target Platform**:
- Contracts: Hedera Testnet（chainId `296`、JSON-RPC relay）
- Backend（Access Gateway）: **Cloudflare Workers**（`workerd`）＋ Durable Objects ＋ Hyperdrive（→ Neon / Supabase Postgres）
- Agent（CI 検証ハーネス）: Node.js プロセス（GitHub Actions / ローカル。本番の自律実行体は外部 MCP クライアント）
- Frontend: 静的ホスティング（**Cloudflare Pages** / Vercel / IPFS）
- Subgraph: Hedera Testnet 対応の**自前ホスト Graph Node**を **AWS CDK でプロビジョニングした EC2 1 台 + docker-compose**（`apps/cdk/`、Hedera JSON-RPC relay を provider に、ハッカソン期間のみ）。Subgraph Studio / Hosted Service は Hedera 非対応

**Project Type**: pnpm monorepo（Turborepo）— `apps/` 配下に frontend（`apps/web`、Vite/React/Tailwind）＋ backend（`apps/gateway`、Hono/Cloudflare Workers、AI Agent 向け MCP Server を相乗り）＋ smart contracts（`apps/contracts`、Hardhat/Hedera）＋ subgraph（`apps/subgraph`、The Graph/GraphQL）＋ agent（`apps/agent`、CI 検証ハーネス、Node）＋ E2E（`apps/e2e`、Playwright）＋ AWS CDK（`apps/cdk`、self-hosted Graph Node、ハッカソン期間のみ）。`packages/shared` にレイヤー共有（v1.6）

**Performance Goals**（§10.4 / SC より）:
- 所有者：wallet 接続 → 復号表示 p50 < 8s / p95 < 15s（SC-001）
- 非所有者：支払い開始 → 復号表示 p50 < 20s / p95 < 40s（SC-002、Hedera finality 3–5s 込み）
- 移転 → 旧所有者の失効反映 < 10s（次の 1 アクセスで、SC-003）
- Concurrent Replay 20 並列 → **アプリ層で 19 件を < 3s に拒否**、成功候補 1 件はオンチェーン `consume` 確定（Hedera finality 3–5s）で確定（SC-005）

**Constraints**:
- 認可判定はオンチェーン直読み（憲章 II）。Rights Graph（自前 Graph Node）は発見・監査のみ
- コア経路にモック不可（憲章 III、SC-009）
- 決済 + `RevenueAllocation` + `ReceiptIssued` は原子的（憲章「settlement は決済と同一 tx」、§10.3）。**primary（1 tx）が day1 検証（T020）で不成立の場合のみ `payFor`+`finalize` フォールバック、非原子を README 開示（FR-008 / 憲章セキュリティ節）**
- 単一チェーン（Hedera）、収益 2 者、返金経路なし、コントラクトウォレット非対応（憲章 VII、spec Assumptions）
- MCP 決済ウォレットは Privy server wallet（session signer + spend policy）で管理、生鍵非保持（憲章 VI / FR-028、R-9）
- 分配誤差 0（端数は protocol treasury → Creator の順、SC-006 / FR-022）

**Scale/Scope**:
- デモ規模：RightsNFT 数個、独占データセット 2 種（各 ≤ 5MB、JSON/CSV）、同時ユーザー数十、Receipt 数十
- コード規模の目安：`apps/contracts` ~800 LOC、`apps/gateway` ~2,900 LOC（MCP Server 実装込み）、`apps/web` ~2,500 LOC、`apps/agent`（CI harness）~250 LOC、`apps/subgraph` ~300 LOC、`apps/cdk` ~150 LOC
- 実装工数：約 19 人日（`docs/idea.md` §11.3）。**実体制は 2 人 + Claude Code / Codex、実働 9 日（2026-09-04〜09-13、提出 09-13 12:00 EDT）**。US1〜US4 は全てスコープ内、人員不足は「深さの tripwire」で吸収する（下記「実行モデル」）

**NEEDS CLARIFICATION**（Phase 0 research.md で解消）:
- R-1: KeyGate の鍵分割構成の最終形（`share_U` の保管・per-wallet blinding・所有者移転時の扱い）
- R-2: Blocky402 facilitator（`api.testnet.blocky402.com`、`/supported` = `hedera:testnet` / `exact` / `feePayer 0.0.7162784`）が、**ネイティブ HBAR value を添付した ContractCall ペイロード**（`RightsRegistry.settleAndIssue{value: price}` を 1 tx）を verify / settle できるか。不可なら「feePayer 宛 plain transfer + permissionless `finalize`」フォールバックの選択
- R-3: Receipt 消費の並行制御を「Durable Object 直列化 + DB UNIQUE 制約 + オンチェーン `consume` の三層」で行う設計の妥当性（憲章 II と憲章 V/セキュリティ要件の両立）
- R-4: Hedera EVM でのネイティブ HBAR value の扱い（`msg.value` は weibar ＝ 10^18、native 精度下限は tinybar ＝ 10^8 → 金額は 10^10 weibar の倍数）、`payable` 関数での受領、`RevenueLib` の分配で dust / 精度ロスが出ないこと、`.call{value:}` での払い出しと返金
- R-5: Rights Graph の Hedera Testnet デプロイ（**自前 Graph Node 一択**＝Subgraph Studio / Hosted Service が Hedera 非対応。The Graph 賞トラックには submit しない）。**ホスティングは AWS CDK でプロビジョニングした EC2 1 台 + docker-compose（`apps/cdk/`、ハッカソン期間のみ、終了後 `cdk destroy`）**。`startBlock` 運用、EC2 インスタンスタイプ / EBS サイズ、Hedera relay を provider にした場合の同期速度を day1（T021）で確認。day1 に Subgraph Studio の Hedera 対応も再確認
- R-6: `resourceHash` / `policyHash` / `purchaseRequestHash` / `receiptHash` の正規化仕様（EIP-712 struct hash に統一）
- R-7: Backend プラットフォーム（Hono + Cloudflare Workers + Durable Objects + Hyperdrive/Postgres）が憲章 II / V と両立するか、Workers runtime で `viem` / `@noble/*` / Postgres ドライバが動くか。**`@modelcontextprotocol/sdk` の Streamable HTTP transport が `workerd` で動くか（FR-026、外部 MCP クライアントからの `tools/list` 疎通。day1 = T019）**
- R-8: モノレポのツールチェーン（pnpm workspace `apps/*` + `packages/*` / Turborepo + Biome + knip + jscpd + Vitest + Playwright）の CI ゲート設計。`apps/cdk` は typecheck / lint 対象だが deploy は CI 外（手動）
- R-9: MCP 決済ウォレットを Privy server wallet（session signer + spend policy）で管理する構成（生鍵非保持、セッション支出上限、method allowlist）の Workers からの利用可否と設定（FR-028 / SC-011 / 憲章 VI）

---

## Constitution Check

*GATE: Phase 0 前に必ず通過。Phase 1 設計後に再チェック。*

| 原則 | 本計画での遵守 | 判定 |
|---|---|---|
| **I. Transfer-Coupled Rights First** | `RightsNFT._update` が `accessEpoch`（＝ Owner Epoch）を自動 +1（唯一の更新主体）。`RightsRegistry` が `licenseEpoch` を別管理。`SURVIVE_TRANSFER` は現在の `accessEpoch` と `ownerEpochAtIssue` の一致を要求しない。移転で「旧所有者失効・新所有者有効・存続ライセンス継続・将来収益の付け替え」を全て実現。全 FR / 全レイヤーが中心命題に紐づく | ✅ PASS |
| **II. 認可の唯一の真実源はオンチェーン状態** | 所有者パス：Gateway（Hono/Workers）が毎リクエスト `RightsNFT.ownerOf` / `accessEpoch` を `viem` で `eth_call`。購入者パス：`RightsRegistry.receiptStatus` / `consume` がオンチェーン権威。Durable Object と DB `UNIQUE` は *Gateway 内の二重送信防止（defense-in-depth）* であり認可の権威ではない（research R-3）。Rights Graph（自前 Graph Node）は Dashboard / Agent 発見のみ、`FR-020` で禁止を明記 | ✅ PASS |
| **III. コア経路にモックを置かない（NON-NEGOTIABLE）** | 実 Hedera Testnet・実 x402 決済（**実ネイティブ HBAR**、Blocky402 facilitator 経由）・実 LLM（**接続先の汎用 MCP クライアント ＝ Claude Code / Codex 等**の分析回答）・実 KeyGate。モックは §11.2 スコープ外要素（AI 推論 API 型資産、ZK、コントラクトウォレット）に限定し README に開示。CI は Testnet 実接続の統合ジョブ（`newman run` 含む）を持つ | ✅ PASS |
| **IV. 敵対的テストを先に書く（NON-NEGOTIABLE）** | `/speckit-tasks` で「§10.1 の 14 行 → 各テスト → 対応ガード」の順序を強制。各エラーコードは `packages/shared/errors.ts` の安定定数。Concurrent Replay は実 20 並列（contract + gateway 両層）。テストなしのガードは done にしない | ✅ PASS（tasks で担保） |
| **V. Request-Bound かつ Single-Use** | `RightsReceipt` struct = 17 フィールド（`chainId`…`issuedAt`）。`receiptHash` = その EIP-712 struct hash（オンチェーン権威）。`purchaseRequestHash` は購入時 1 回計算・アクセス呼び出し内容を含めない。消費は `RightsRegistry.consume`（オンチェーン原子）＋ Gateway 側 `SELECT ... FOR UPDATE` ＋ `UNIQUE(receipt_hash, use_index)` / `UNIQUE(payment_id, purchase_request_hash)`。`share_G` は settle / consume 確認後にのみ放出 | ✅ PASS |
| **VI. 最小権限・短命アクセス** | 平文・完全鍵をオンチェーンに置かない。`K = share_G XOR share_U`。**licensee パスは 2 回目以降のアクセスで完全準拠**（`blinded_U` は licensee 署名に束縛、`share_U` は初回発行時のみ一時参照して破棄。2026-09-06 訂正：初回アクセス時は認証チャレンジ処理中に `sig_wallet`/`share_U` を同時に扱うため、その瞬間に限り Gateway は理論上 `K` を再構築できる材料を持つ ― R-1a 参照）。**owner（無料/MVP）パスは残存信頼点**：新所有者が随時現れるため `share_U` を Workers Secrets Store に保持し、Gateway デプロイの完全侵害で平文が復元されうる → **Complexity Tracking に逸脱として記録**。`share_G` 放出は短命・セッションスコープ。Wallet チャレンジに nonce + expiry + `chainId`（FR-024）。監査ログ（FR-023、gateway の allow/deny を `audit_log` へ。T060 / T067 でテスト）。**MCP 決済ウォレットは Privy server wallet（session signer + spend policy、生鍵非保持、method allowlist、セッション上限）で管理**（FR-028 / SC-011 / R-9）。production は `share_U` を Shamir 2-of-3（`docs/idea.md` v1.4 stretch） | ⚠️ 条件付き PASS（owner パス＋licensee 初回アクセスに残存信頼点、下記 Complexity Tracking） |
| **VII. 正直な主張とスコープ規律** | 非ゴール遵守：Hedera 一本化 / 収益 2 者 / ERC-1271 非対応（FR-025）/ 返金なし / ZK 設計のみ / DRM なし。主張は「Rights Gateway の request-binding・idempotency・settle-before-release・並行制御を実装」に限定。信頼モデル段落（`docs/idea.md` §9.1）を README に転記：owner パスの `share_U` 保持、Gateway 可用性の単一障害点、原子性フォールバック時の非 trustless 前提、MCP 公開エンドポイントの Privy policy 制約付き決済ウォレット、事前作業（`hedra-sample`）の開示 | ✅ PASS |
| **セキュリティ・脅威モデル要件** | EIP-712 ドメイン束縛（`chainId` + `verifyingContract`）。`paymentId` 一回限り（`PAYMENT_ID_PAYLOAD_CONFLICT`）。原子的消費。**settlement は決済と同一 tx で原子的**（R-2 primary が既定）。primary 不成立時のフォールバックは **Complexity Tracking に条件付きで記録済み**＋ README 開示（既定ではない、FR-008）。**MCP 決済ウォレットのポリシー制約**（支出上限・method allowlist、FR-028）。エラーコードは公開契約。暗号化ストアは暗号文のみ露出 | ✅ PASS（primary 既定、逸脱は条件付き記録） |
| **ハッカソン納品ワークフロー** | **submit 対象 3 枠：Hedera「AI & Agentic Payments」＋ Privy「Best Financial Flow」＋ Privy「Best B2B Financial Product」**（Privy control ＝ MCP 決済ウォレットの spend policy）。いずれも load-bearing（Hedera ＝コア実行基盤 / Privy ＝所有者・AI クライアントのウォレット + 決済ポリシー basis）。**The Graph の Rights Graph（自前 Graph Node）は発見・監査に必要だが、Hedera が Subgraph Studio / The Graph Market 非対応のため Graph の賞トラックには submit しない**（day1 再確認）。3 分デモ台本（§13.2）＝ 納品契約。DoD §20 を quickstart にマップ | ✅ PASS |

**初回結果：憲章 VI の owner パスに残存信頼点（Complexity Tracking に記録）＋ settlement 原子性のフォールバックを条件付き記録。他は違反なし。** research R-1〜R-8 は「設計の詳細確定」であり原則違反ではない（Phase 0 で解消）。

### Phase 1 設計後の再チェック（2026-09-02）

Phase 0（`research.md`）と Phase 1（`data-model.md` / `contracts/*` / `quickstart.md`）で新たな違反は生じなかった。特に確認した点：

- **憲章 II の再確認**：`gateway-api.md` の全認可エンドポイント（`/owner/keygate`, `/keygate/share`）が `eth_call`（`ownerOf` / `accessEpoch` / `receiptStatus` / `hasValidConsumption`）を判定の権威として使い、DB は `SELECT ... FOR UPDATE` の重複防止に限定と明記。`FR-020` を `subgraph-schema.md` にも転記。→ PASS
- **憲章 V の再確認**：`eip712-types.md` に 17 フィールドと `receiptHash = hashStruct` を確定。`purchaseRequestHash` は「アクセス呼び出し内容を含めない」と明記。`data-model.md` の DB スキーマに `UNIQUE(receipt_hash, use_index)` / `UNIQUE(payment_id, purchase_request_hash)` を定義。→ PASS
- **憲章 VI の再確認**：licensee パスは `blinded_U` が licensee 署名に束縛され `share_U` を発行時に破棄 → VI 準拠。**owner パスは `share_U` を Secrets Store に保持し Gateway が再取得可能 → 憲章 VI の「仲介者が保持する部分単独では復号に無意味」を owner パスでは満たさない**。→ Complexity Tracking に逸脱として記録、README で開示（T123 / T122）。production は Shamir 2-of-3。
加えて **KeyGate fallback 経路（T077）** は本命未達時に Gateway が平文・完全鍵を扱うため、同じく Complexity Tracking に条件付き逸脱として記録（Phase 7 tripwire で発効、既定ではない）。
- **セキュリティ要件（settlement 原子性）の再確認**：`research.md` R-2 で primary（1 Hedera tx の value 付き ContractCall）を第一候補・既定に据え、`solidity-interfaces.md` の `settleAndIssue` に原子的ロジックを定義。**primary 不成立時（T020 の day1 検証で判明）のフォールバック `payFor` / `finalize` / `refundUnfinalized` は Complexity Tracking の条件付き行が発効**。→ PASS（primary 既定）
- **憲章 IV の担保方法**：`contracts/error-codes.md` の 14 行 × 1 テストを `/speckit-tasks` で「テスト → ガード」順に生成させる。golden test（EIP-712 の Solidity↔TS 一致）も必須タスク。→ tasks で担保
- **API 契約の一貫性（FR-029）**：`packages/openapi/openapi.yaml` を Access Gateway API の単一定義とし、gateway / web / agent が生成型を共有。§10.1 のエラーコードは `openapi.yaml` にも列挙し、`newman run`（`apps/e2e/postman/`）で実デプロイのレスポンスがスキーマ適合することを検証。憲章「エラーコードは公開契約」「正確な主張」を補強し、新たな違反はない。→ tasks で担保

**設計後：憲章 VI の owner パス残存信頼点と settlement 原子性フォールバックを Complexity Tracking に記録。他は違反なし。**

### ツールチェーン変更（Hono + Cloudflare Workers 採用）後の再チェック

`research.md` R-7（backend を Hono + Cloudflare Workers + Durable Objects + Hyperdrive/Postgres へ）・R-8（pnpm + Turborepo + Biome + knip + jscpd）を反映しても憲章違反は生じない：

- **憲章 II**：`share_G` 放出前の `eth_call`（`viem`、Hedera relay）は Workers runtime でも同一。DO / KV / Postgres は非権威（防御的多重化）。
- **憲章 V**：Hyperdrive 経由の通常 Postgres で `SELECT ... FOR UPDATE` / `UNIQUE(receipt_hash, use_index)` / `UNIQUE(payment_id, purchase_request_hash)` を維持。加えて **Durable Object の直列実行が「原子的スクリプト」に相当**（憲章が明示的に許容する選択肢）。
- **憲章 III**：Workers は実インフラ。`wrangler dev`（miniflare）はローカル開発のみで、CI/デモは実 Workers + 実 Hedera Testnet。
- **憲章 VI**：`share_G` = Workers KV（KEK 暗号）、`share_U` / 署名鍵 = Workers Secrets Store（KV・DB の外）。DB/KV 単体からの復号は不可。ただし owner パスの `share_U` は Gateway が再取得可能なため Complexity Tracking に逸脱記録（上記）。
- **`.claude/rules/testing.md`（Vitest）/ `code-style.md`**：Biome の lint ルールで const-first・`type` vs `interface`・`satisfies` を機械化。Vitest はプロジェクト規約と一致。

R-7 / R-8 は day1 の疎通確認タスク（`viem` / `@noble/*` / Postgres ドライバの Workers 動作、`@cloudflare/vitest-pool-workers` での DO テスト）を伴うが、設計上のブロッカーではない。

---

## Project Structure

### Documentation（this feature）

```text
specs/001-rights-runtime-mvp/
├── plan.md                     # 本ファイル
├── research.md                 # Phase 0：R-1〜R-9 の決定・根拠・代替案
├── data-model.md               # Phase 1：オンチェーン + オフチェーンのエンティティ
├── quickstart.md               # Phase 1：SC-001〜010 と 14 攻撃の検証手順
├── contracts/                  # Phase 1：レイヤー間の契約
│   ├── README.md               #   契約インデックス
│   ├── solidity-interfaces.md  #   RightsNFT / RightsRegistry の I/F・イベント・エラー
│   ├── gateway-api.md          #   Access Gateway HTTP API（OpenAPI 風）
│   ├── mcp-tools.md            #   AI Agent 向け MCP Server ツール（discover_assets/buy_access/decrypt_content、v1.6）
│   ├── eip712-types.md         #   RightsReceipt / KeyGateChallenge / OwnerAuthChallenge の typed data
│   ├── error-codes.md          #   §10.1 の 14 種 + 補助コード（公開契約）
│   ├── subgraph-schema.md      #   Rights Graph の GraphQL エンティティ・イベントマッピング
│   └── rights-manifest.schema.json  # Rights Manifest（zod 由来 JSON Schema）
└── checklists/requirements.md   # spec 品質チェック（作成済み）
```

### Source Code（repository root）— pnpm monorepo

```text
truenft/
├── package.json                # pnpm workspace ルート（scripts: dev / build / test / lint / check）
├── pnpm-workspace.yaml         # globs: apps/* + packages/*
├── turbo.json                  # Turborepo：build / lint / test / typecheck のタスクグラフ
├── biome.json                  # lint + format（全 workspace 一括、ESLint/Prettier なし）
├── knip.json                   # 未使用ファイル・export・dependency 検出（CI で fail）
├── .jscpd.json                 # コード重複（copy-paste）検出のしきい値
├── vitest.workspace.ts         # apps/gateway / apps/web / apps/agent / packages/shared / packages/openapi のテストを束ねる
├── tsconfig.base.json          # 共通 compilerOptions（strict、path alias @/）
├── .env.example                # HEDERA_RPC_URL, HEDERA_OPERATOR_KEY, X402_FACILITATOR_URL, ANTHROPIC_API_KEY, HYPERDRIVE_URL, AWS_REGION, ...
│
├── packages/
│   ├── shared/                 # 全レイヤー共有（型・定数・スキーマ）— CF Workers / Node / ブラウザ全対応
│   │   ├── src/
│   │   │   ├── errors.ts       #   ErrorCode 列挙（14 + 補助）— 公開契約
│   │   │   ├── eip712.ts       #   ドメイン・struct 定義・receiptHash / purchaseRequestHash 計算
│   │   │   ├── manifest.ts     #   RightsManifest の zod スキーマ + 型
│   │   │   ├── hashing.ts      #   resourceHash / policyHash / conditionsHash（keccak・正規化）
│   │   │   ├── addresses.ts    #   デプロイ済みコントラクト（RightsNFT / RightsRegistry）アドレス（env 上書き可）
│   │   │   ├── kv-format.ts    #   share_G の KEK 暗号フォーマット（seed の投入と gateway の読み出しで共有、FR-016）
│   │   │   └── abi/            #   生成 ABI（apps/contracts ビルドから同期）
│   │   └── package.json
│   │
│   └── openapi/                # Access Gateway HTTP API の単一の真実源（機械可読）
│       ├── openapi.yaml        #   OpenAPI 3.1。全エンドポイント・スキーマ・ErrorCode を定義（`contracts/gateway-api.md` の機械可読版）
│       ├── src/types.ts        #   `openapi-typescript` で openapi.yaml から生成（`generate` script、コミットしない or 生成物として管理）
│       ├── src/index.ts        #   生成型の re-export（`paths` / `components["schemas"]`）+ 型ヘルパ
│       └── package.json        #   exports: `.`（生成型）。scripts: `generate`（openapi-typescript）/ `lint`（redocly）
│
├── apps/
│   ├── contracts/              # ── Smart Contract 層 ──
│   │   ├── contracts/
│   │   │   ├── RightsNFT.sol       #   ERC-721 + accessEpoch（_update で自動 +1）+ policyHash 登録
│   │   │   ├── RightsRegistry.sol  #   settleAndIssue / consume / claim / bumpLicenseEpoch
│   │   │   ├── libraries/
│   │   │   │   ├── ReceiptLib.sol  #   RightsReceipt struct・EIP-712 hash・検証
│   │   │   │   ├── RevenueLib.sol  #   mulDiv 2 者按分 + 端数規則（余りを treasury→creator、SC-006）
│   │   │   │   └── PayLib.sol      #   ネイティブ HBAR の安全な払い出し（`Address.sendValue` + 失敗チェック）。claim / refund が使用
│   │   │   ├── interfaces/
│   │   │   │   ├── IRightsNFT.sol
│   │   │   │   └── IRightsRegistry.sol
│   │   │   └── probe/ProbeSettle.sol  #   day1 用の使い捨てスタンドイン（T020。ReceiptParams 非依存、Phase 3 で削除・deploy 対象外）
│   │   ├── test/                   #   §10.1 の 14 行（contract 層で表現できるもの）+ ハッピーパス
│   │   ├── scripts/
│   │   │   ├── deploy.ts           #   Hedera Testnet デプロイ + packages/shared/src/addresses.ts へ書き戻し + HashScan verify
│   │   │   ├── seed.ts             #   デモ用 NFT mint・Manifest 登録・暗号文 IPFS・seed-artifacts.json 出力（share は配布しない）
│   │   │   └── probe-hedera.ts     #   day1：ネイティブ HBAR value 挙動の検証（T018）
│   │   ├── out/seed-artifacts.json #   seed の出力（CID / 生 share / conditionsHash）。T076 が KV/Secrets へ投入
│   │   └── hardhat.config.ts       #   Solidity 0.8.34 / evm cancun / network testnet
│   │
│   ├── gateway/                # ── Backend 層（Access Gateway、Hono + Cloudflare Workers）──
│   │   ├── wrangler.toml           #   Workers 設定：durable_objects / kv_namespaces / hyperdrive / secrets
│   │   ├── src/
│   │   │   ├── index.ts            #   Hono app エクスポート（fetch handler）＋ DO クラス export
│   │   │   ├── routes/
│   │   │   │   ├── preview.ts      #   GET /assets, GET /assets/:id/preview（認可なし・FR-019）
│   │   │   │   ├── ownerAccess.ts  #   POST /owner/challenge, POST /owner/keygate（所有者パス）
│   │   │   │   ├── x402.ts         #   x402-hono middleware + settle 検証 + Receipt 発行（FR-004..009）
│   │   │   │   ├── keygate.ts      #   POST /keygate/share（receipt + useIndex → share_G 放出）
│   │   │   │   ├── graph.ts        #   GET/POST /graph（subgraph GraphQL パススルー、FR-020）
│   │   │   │   ├── audit.ts        #   GET /audit（FR-023）
│   │   │   │   ├── admin.ts        #   POST /assets/:id/bump-license-epoch（creator 署名、緊急失効）
│   │   │   │   └── mcp.ts          #   POST/GET /mcp（Streamable HTTP、MCP Server マウント。FR-026・v1.6）
│   │   │   ├── mcp/                #   ── MCP Server 本体（v1.6、@modelcontextprotocol/sdk）──
│   │   │   │   ├── server.ts       #   McpServer 定義・ツール登録・Streamable HTTP transport
│   │   │   │   ├── tools/
│   │   │   │   │   ├── discoverAssets.ts   #   subgraph 経由の資産発見（graph/cache.ts 再利用、FR-020）
│   │   │   │   │   ├── buyAccess.ts        #   Privy server wallet でx402署名・submit（x402/facilitator.ts 再利用）
│   │   │   │   │   └── decryptContent.ts   #   licensee署名からshare_U導出→K復元→復号（keygate/* 再利用）
│   │   │   │   └── wallet.ts       #   Privy server wallet：session signer 初期化 + spend policy（method allowlist / セッション上限 / rate limit）。生鍵非保持（R-9・FR-028）
│   │   │   ├── do/
│   │   │   │   └── ReceiptLock.ts  #   Durable Object：receiptHash ごとに consume を直列化（R-3）
│   │   │   ├── chain/
│   │   │   │   ├── clients.ts      #   viem public/wallet client（Hedera relay）
│   │   │   │   ├── reads.ts        #   ownerOf / accessEpoch / receiptStatus / hasValidConsumption 直読み（憲章 II）
│   │   │   │   └── writes.ts       #   consume / settleAndIssue / bumpLicenseEpoch の tx 送出
│   │   │   ├── keygate/
│   │   │   │   ├── split.ts        #   K = share_G XOR share_U・per-wallet blinding
│   │   │   │   ├── release.ts      #   放出判定（owner / licensee パスの条件評価）
│   │   │   │   ├── fallback.ts     #   KeyGate 本命未達時の素の放出経路（TTL 署名 URL。Complexity Tracking 開示対象）
│   │   │   │   └── secrets.ts      #   share_U・署名鍵の取得（Workers Secrets Store、KV/DB 外）
│   │   │   ├── auth/               #   OwnerAuthChallenge / KeyGateChallenge 署名検証・nonce
│   │   │   ├── middleware/rateLimit.ts  #   wallet / IP ごとのレート制限（RATE_LIMITED、§9.2）
│   │   │   ├── receipt/issue.ts    #   EIP-712 署名生成（tx 確定後・利便クレデンシャル）
│   │   │   ├── db/
│   │   │   │   ├── schema.ts       #   drizzle スキーマ（data-model.md）
│   │   │   │   └── migrations/     #   Hyperdrive 経由 Postgres
│   │   │   ├── kv/shareStore.ts    #   share_G の KV read/write（KEK 暗号、packages/shared/kv-format.ts）
│   │   │   ├── x402/facilitator.ts #   Blocky402 facilitator client（value 付き ContractCall / payFor+finalize、R-2）
│   │   │   ├── graph/cache.ts      #   subgraph 補完キャッシュ（認可には不使用、FR-020）
│   │   │   ├── audit/log.ts        #   FR-023 監査ログ（audit_log テーブル）
│   │   │   └── errors.ts           #   ErrorCode → HTTP マッピング（openapi の Error スキーマに一致）
│   │   ├── scripts/                #   probe-workerd.ts / probe-x402.ts（day1）・load-shares.ts（seed-artifacts → KV/Secrets）
│   │   └── test/                   #   Vitest（@cloudflare/vitest-pool-workers）: ownerAccess / x402 / keygate / DO / adversarial / audit / mcpWalletPolicy
│   │
│   ├── web/                    # ── Frontend 層（Vite + React + Tailwind + Privy）──
│   │   ├── tailwind.config.ts      #   最小設定（デザイントークンのみ）
│   │   ├── vite.config.ts          #   @tailwindcss/vite プラグイン
│   │   ├── src/
│   │   │   ├── main.tsx / App.tsx  #   PrivyProvider・ルーティング・index.css（@import "tailwindcss"）
│   │   │   ├── routes/
│   │   │   │   ├── Creator.tsx     #   アップロード → クライアント側暗号化 → Manifest → mint
│   │   │   │   ├── Market.tsx      #   Rights Graph 一覧・プレビュー・購入 / 所有者アクセス
│   │   │   │   ├── Viewer.tsx      #   KeyGate 復号・データセット表示
│   │   │   │   └── Dashboard.tsx   #   Rights Graph 監査ビュー + デモ用 2 分割画面
│   │   │   ├── keygate/
│   │   │   │   ├── deriveShareU.ts #   固定チャレンジ署名 → HKDF → share_U'
│   │   │   │   └── decrypt.ts      #   K 復元 + AES-256-GCM 復号（Web Crypto）
│   │   │   ├── api/client.ts       #   packages/openapi 生成型で型付けした Gateway API クライアント（openapi-fetch）。web→gateway は全部これ経由（FR-029 / SC-012）
│   │   │   ├── graph/queries.ts    #   graphql-request で Rights Graph をクエリ
│   │   │   ├── chain/hooks.ts      #   viem + Privy wallet
│   │   │   ├── x402/buy.ts         #   x402-fetch でネイティブ HBAR の支払い認可を Privy 署名
│   │   │   └── components/         #   PricePanel / RightsBadge / EpochTimeline（2 レーン）/ SplitScreen / AttackCounter（Tailwind）
│   │   └── test/                   #   Vitest（コンポーネント・hooks）／ Playwright spec は apps/e2e で実行
│   │
│   ├── agent/                  # ── CI検証ハーネス（v1.6・本番の実行体は apps/gateway/src/mcp/）──
│   │   ├── src/
│   │   │   ├── mcpClient.ts        #   apps/gateway の /mcp（Streamable HTTP）へ接続する自前 MCP クライアント
│   │   │   └── analyze.ts          #   Claude tool-use：discover_assets/buy_access/decrypt_content を呼び分析回答（実推論、SC-007/009）
│   │   └── test/autonomous.spec.ts #   discover→buy→decrypt→analyze を人手0で完走（SC-007/009）
│   │
│   ├── subgraph/               # ── Data supply（The Graph / GraphQL、Rights Graph）──
│   │   ├── schema.graphql          #   RightsToken / Receipt / Consumption / RevenueAllocation ...
│   │   ├── subgraph.yaml           #   network: testnet / RightsNFT + RightsRegistry / startBlock
│   │   ├── src/mappings/
│   │   │   ├── rightsNft.ts        #   handleTransfer / handlePolicyUpdated
│   │   │   └── rightsRegistry.ts   #   handleReceiptIssued / handleReceiptConsumed / handleRevenueAllocated / handleClaimed / handleLicenseEpochBumped
│   │   └── tests/                  #   matchstick-as：fixture イベント → エンティティ生成の unit test（`graph test`）
│   │
│   ├── e2e/                    # ── E2E（ブラウザ = Playwright、API = Postman/Newman）──
│   │   ├── playwright.config.ts
│   │   ├── wallets.ts / .accounts.json  #   資金付きテストアカウント（seed.ts が出力）
│   │   ├── metrics.ts             #   SC-001/002/003/005 レイテンシ集計 → metrics.json
│   │   ├── demo-3min.e2e.ts       #   quickstart.md §2 の 3 分デモ台本の自動通し
│   │   ├── onchain-indexer.e2e.ts #   E2E#1：deploy→seed→tx→ Graph Node の index を GraphQL で検証（Phase 6）
│   │   ├── attacks.e2e.ts         #   Concurrent Replay（実 20 並列）/ Chain ID Spoofing / Cross-Resource
│   │   └── postman/               #   Access Gateway API の E2E（Newman で実行）
│   │       ├── gateway.postman_collection.json   #   preview / owner / x402 / keygate / audit / 14 エラーマトリクスの HTTP 断面。レスポンスは packages/openapi のスキーマに適合を assert
│   │       └── hedera-testnet.postman_environment.json
│   │
│   └── cdk/                    # ── AWS CDK（TypeScript）── ※ハッカソン期間のみの一時インフラ
│       ├── bin/cdk.ts
│       ├── lib/graph-node-stack.ts     #   EC2 1台 + Elastic IP + Security Group + EBS。user-data で docker compose up
│       ├── docker/
│       │   └── docker-compose.graph-node.yml  #   graph-node + postgres + ipfs の 3 コンテナ。ethereum provider = Hedera JSON-RPC relay
│       ├── scripts/probe-graph-node.sh #   day1：最小スタック deploy + Subgraph Studio 再確認（T021）
│       ├── test/graph-node-stack.test.ts  #   aws-cdk-lib/assertions（SG / EBS / user-data、T055）
│       ├── cdk.json
│       └── package.json
```

**Structure Decision**:
`docs/idea.md` §9 のコンポーネント責務がそのままレイヤー分割になる。**pnpm workspace（Turborepo）**：`apps/` にデプロイ可能な成果物（`apps/contracts` = Hardhat ／ `apps/gateway` = Hono + Cloudflare Workers ／ `apps/web` = Vite + React + Tailwind ／ `apps/agent` = Node CI ハーネス ／ `apps/subgraph` = The Graph ／ `apps/e2e` = Playwright ／ `apps/cdk` = AWS インフラ（self-hosted Graph Node、ハッカソン期間のみ））、`packages/shared` にレイヤー共有。

- **`apps/` に集約する理由**：6 つの成果物はすべて「独立してビルド・テスト・デプロイできる単位」。`pnpm-workspace.yaml` は `apps/*` の 1 行で列挙でき、ルートスクリプトと Turborepo タスクグラフが素直になる。共有ロジックは `packages/shared` のみ（`apps/*` 同士は直接依存しない）。
- **`packages/shared` は必須**：エラーコード・EIP-712 型・ハッシュ計算・Manifest スキーマを 1 か所に。ここが崩れるとレイヤー間で `receiptHash` 一致が保証できない（憲章 V）。CF Workers / Node / ブラウザすべてで動くよう副作用なし・Node 専用 API なしで書く。
- **`packages/openapi` は API 契約の SoT**：`openapi.yaml`（OpenAPI 3.1）に Access Gateway の全エンドポイント・リクエスト/レスポンススキーマ・`ErrorCode` を定義し、`openapi-typescript` で型を生成。`apps/gateway`（ハンドラ I/O）と `apps/web` / `apps/agent`（呼び出し側）が同じ生成型を import することで、フロント/バックの API 型ズレを `tsc` で検知する。`packages/shared`（オンチェーン/暗号のドメイン型）とは責務が別（HTTP 境界の型）で、両者は独立。エラーコードの実体は `packages/shared/errors.ts` の enum が正典で、`openapi.yaml` はそれを列挙するだけ（二重定義を避け、`T039` の stability テストで一致を検証）。
- **`apps/gateway` = Hono on Cloudflare Workers**：`x402-hono` があり、`wrangler` でのデプロイが速く、**Durable Objects が `receiptHash` ごとの consume 直列化に最適**（R-3。「exactly-1」をアプリ層で担保しつつオンチェーンが最終権威）。Hyperdrive で既存の Postgres 前提（`SELECT ... FOR UPDATE` / `UNIQUE`）を維持。
- **AI Agent 向けの本番実行体は MCP Server として `apps/gateway`（Cloudflare Workers）に相乗り**（v1.6）：discover_assets / buy_access / decrypt_content の3ツールを `/mcp`（Streamable HTTP）で公開し、Claude Code / Codex 等の外部AIクライアントが直接接続する。gateway と同一 Workers上のため `chain/` `keygate/` `x402/` `graph/cache.ts` をそのまま再利用でき、新規デプロイ面を増やさない。
- **`apps/agent` は CI 検証ハーネスに用途を限定**（旧「自律 agent プロセス」から変更）：憲章 III / SC-007 の「人手介入 0」を、外部AIクライアントを起動できない CI 環境でも自動検証するため、`/mcp` へ接続する自前 MCP クライアント + Claude tool-use のスクリプトとして Node の通常プロセスで残す。本番のAIエージェント実行はこれではなく、Claude Code / Codex 側が担う。
- **`apps/web` は Cloudflare Pages に静的デプロイ**可（gateway と同じ Cloudflare で一貫）。
- **`apps/subgraph` のホスティングは `apps/cdk`**：Hedera が Subgraph Studio / Hosted Service 非対応のため、AWS CDK で **EC2 1 台 + docker-compose**（`graph-node` + PostgreSQL + IPFS）を建てて `graph deploy` する。ハッカソン期間限定の一時インフラで、終了後 `cdk destroy`。The Graph の賞トラックには submit しない（R-5）。
- Foundry は Hardhat と併存可（`forge` fuzz）。`apps/contracts` のテストのみ Hardhat runner、それ以外は Vitest。
- **コード品質は monorepo 一括**：`biome`（lint+format）／ `knip`（デッドコード・未使用依存）／ `jscpd`（重複）／ `tsc --noEmit`。すべて `turbo` タスク＋ CI ゲート。`apps/cdk` は typecheck / lint 対象だが `cdk deploy` は CI 外（手動）。

---

## Complexity Tracking

| 逸脱 | なぜ必要か | 却下した簡易案 | 緩和策・開示 |
|---|---|---|---|
| **憲章 VI**：owner（無料）パスの `share_U` を Access Gateway（Workers Secrets Store）が保持し再取得可能 | NFT の新所有者は移転のたびに随時現れ、その都度当該所有者向けの `blinded_U` を計算するには `share_U` を Gateway が再取得できる必要がある。分散鍵ネットワーク（Lit/TACo/iExec）は Hedera 非対応（R-1）、Shamir 2-of-3 の運用は 9 日・2 人の枠では stretch | (a) `share_U` を Manifest に公開 → Gateway が両シェアを持つのと同義でさらに弱い。(b) 移転時に旧所有者/Creator が `K` を新所有者へ再ラップ → FR-015 が禁じる再暗号化に相当 | **licensee（有料）パスは VI 完全準拠**（`blinded_U` は licensee 署名に束縛、`share_U` は発行時のみ一時参照して破棄）。owner パスの残存信頼点は README 信頼モデル段落（T123）・no-mocks 監査（T122）で開示。production は `share_U` を独立オペレータ 3 ノードの Shamir 2-of-3 に分散（`docs/idea.md` v1.4 stretch。I/F `KeyGate.getShareU()` の差し替えのみ） |
| **憲章 セキュリティ節：settlement 原子性のフォールバック（条件付き）** | R-2 primary（Blocky402 の `exact` で `settleAndIssue{value: price}` を 1 tx 実行）が day1 未検証。Blocky402 の `hedera:testnet` / `exact` が「feePayer 宛の plain native transfer」しか扱えず、value 付き ContractCall ペイロードを verify / settle できないと primary は不成立 | primary が最も単純かつ目標。3 段構成は複雑化のため既定にしない | **T020（day1 probe）で primary 不可と判明した場合に限り** `payFor`/`finalize`/`refundUnfinalized`（HBAR は常にコントラクト管理・非 custody・permissionless finalize・timeout 返金）へ切替。憲章「やむを得ず…限り」に該当し、README（T123）で「決済と anchor は非原子」と開示。既定の設計ではない |
| **憲章 VI / FR-016：KeyGate fallback 経路で Gateway が平文・完全鍵を扱う（条件付き）** | KeyGate 本命（`K = share_G XOR share_U'`、クライアント側復号）が Phase 7 で green にならない場合、「暗号化パートは常に動く」保証（`docs/idea.md` v1.4 段階設計）を満たす経路が他に無い。fallback（`apps/gateway/src/keygate/fallback.ts`、T077）は認可チェック（T072 オンチェーン直読み）通過後に TTL 付き署名 URL / 復号ストリームを返すため、この経路が有効な間は Gateway が平文・完全鍵にアクセスできる | (a) fallback を作らず暗号化パートを賭ける → green しなければデモ全体が崩れる。(b) 分散鍵ネットワークは Hedera 非対応 | **既定は本命**（T081/T083）。fallback は Phase 7 tripwire でのみ発効し、発効時は README 信頼モデル段落（T123）で「この経路では Gateway が平文を扱う」と明示開示。発効後も本命が green 次第 `keygate/release.ts` のモード切替のみで復帰（I/F 不変）。production は `share_U` の Shamir 2-of-3（v1.4 stretch）で fallback 自体を不要化 |

（記録）monorepo のワークスペース分割（`apps/` に 7 成果物：contracts / gateway / web / agent / subgraph / e2e / cdk ＋ `packages/shared`〔ドメイン型〕＋ `packages/openapi`〔HTTP API 契約〕）は「レイヤー分離 = 責務分離」であり過剰分割ではない。単一パッケージに畳むと `apps/contracts` のビルド成果物（ABI・型）と `apps/gateway` `apps/web` `apps/agent` の依存が循環し、`packages/shared` の役割（ハッシュ計算の単一定義）が果たせない。`apps/cdk` は Hedera が Subgraph Studio 非対応（R-5）という外部制約に由来する一時インフラであり、ハッカソン終了後は `cdk destroy` で撤去する前提（恒久設計ではない）。

### マルチモデル設計レビュー対応（2026-09-05・Codex GPT-6-Astra × Fable 5.1）

実装着手前に、独立した2つのモデルによる設計レビューを実施した。両モデルが独立に一致して発見した Critical 指摘（`settleAndIssue` の policy 内容未検証・決済レール前提の共有リスク・KeyGate 認証と鍵導出の混在）と、Fable のみが発見した Critical 相当の指摘（MCP `decrypt_content` の無認証共有ウォレット問題）は、`research.md` に R-1a / R-2a / R-3a / R-6a / R-9a / R-10 / R-11 として決定を記録し、対応する `contracts/*.md` / `data-model.md` を修正済み。要点：

| 逸脱・修正 | 内容 | 発見元 |
|---|---|---|
| `settleAndIssue` の policy content 未検証 | `p.policyHash` を price/maxUses/transferMode 等から再導出して照合する require を追加（フィールド追加なし、`expiresAt - issuedAt` から duration を逆算） | Codex #1・Fable C-1（独立一致） |
| KeyGate 認証と鍵導出の混在 | `KeyGateChallenge`（固定・鍵導出専用）と `OwnerAuthChallenge`/`LicenseeAuthChallenge`（nonce 付き・認証専用）を分離。`blindedU` は初回のみ計算。**ただし初回アクセス時に限り Gateway が `sig_wallet`/`share_U` を同時に扱う限界は残る**（2026-09-06 訂正、Codex 再レビュー指摘：「完全準拠」は過大主張だった。Complexity Tracking 表・R-1a 参照） | Codex #6（High）・Fable C-3（Critical、独立一致） |
| 決済レール（primary/fallback）が同一未検証仮定を共有 | T020 probe を primary・fallback 両方の ContractCall 対応確認に拡張。第 3 案（非原子カストディ型）を day1 に文書化済み | Codex #4（High）・Fable C-2（Critical、独立一致） |
| MCP `decrypt_content` が無認証共有ウォレットで他人の購入済みコンテンツを読める | `mcp_session_binding` で `receiptHash` を MCP セッションに束縛 | **Fable H-1 のみが発見**（Codex 未指摘） |
| fallback 採用時、permissionless `finalize` が収益転用可能 | `payFor`/`finalize` に `committedParamsHash` を導入し購入内容を入金時点に固定 | **Codex #2 のみが発見**（Fable 未指摘） |

この対応により、`plan.md` の Complexity Tracking に新たな恒久的な逸脱は増えていない（いずれも「実装がまだ存在しない段階での設計修正」であり、既存の逸脱記録〔owner パスの `share_U` 残存信頼点／settlement 原子性フォールバック／KeyGate fallback〕とは独立）。詳細な問題内容・失敗シナリオ・推奨対応は各 R 節（`research.md`）を参照。

---

## 実行モデルとスコープ規律（2 人 + Claude Code / Codex）

**2026-09-04 決定 / 2026-09-04 実行順を改訂。** ETHGlobal ETHOnline 2026 の競争レベルを踏まえ、差別化の核（二層 epoch の並置デモ、攻撃のライブ拒否）を妥協しない。**spec.md の US1〜US4 はすべてスコープに残す**（＝仕様の要件は落とさない）。ただし **実装順は「ユーザーストーリー縦割り」ではなく「レイヤー水平 ＋ E2E ゲート」**に変更した（開発量が非常に多く、各レイヤーを完成させてから次へ進む方が完走確実性が高いため）。順序は `基盤 → コントラクト → subgraph → CDK/Graph Node → E2E#1 → gateway → E2E#2 → web → E2E#3 → agent → ドキュメント`。詳細な分担・9 日スケジュール骨子・tripwire 表は `tasks.md`「Dependencies & Execution Order」「Implementation Strategy」に置く。人員不足は「レイヤーを切る」のではなく「タスク内の深さを切る tripwire」で吸収する。

### 分担の要点

| | 担当 | 不変条件 |
|---|---|---|
| **Dev-1** | 権威コア：`apps/contracts` 全部 / `packages/shared`（主導）/ `apps/gateway` の `chain/` `keygate/` `x402/` `do/` `auth/` | `receiptHash` のクロスレイヤー一致（憲章 V）を単独で握る。`packages/shared/src/eip712.ts` / `hashing.ts` を他者が編集しない |
| **Dev-2** | `apps/web` 全部 / `apps/subgraph` / `apps/cdk`（Graph Node インフラ）/ `packages/openapi`（`openapi.yaml` 主導）/ `apps/gateway` の `routes/` + `src/mcp/` / `apps/agent` / `apps/e2e`（Playwright + Postman/Newman）/ README / デモ動画 | 提出物（動画 2〜4 分・話者ナレーション・720p・速度操作なし）とスポンサー要件充足（T126）に責任を持つ。`packages/openapi/openapi.yaml` は API のクロスチーム契約 ― エンドポイント追加時は Dev-1 と同期し、`ErrorCode` は `packages/shared/errors.ts` を正典として列挙のみ |

### AI 活用の前提（`.claude/rules/*` に準拠）

- 各タスク（または論理グループ）を **1 サブエージェントに割り当て**、`contracts/*.md` の該当契約と規約ファイルをプロンプトに再掲する（親コンテキストを膨らませない）。並列起動は 2〜3 個まで、原則逐次（`development.md`）。
- **テスト先行（憲章 IV）が AI と好相性**：各ビルド Phase（3 / 7 / 9）でテストタスクを red で作り、実装を AI に投げ、green を確認。`scripts/audit-no-mocks.sh`（T017 で CI に載せ、T122 で最終 pass）で AI 生成スタブのコア経路混入を機械的に排除（SC-009）。
- golden test（T027 TS / T030 Sol）を常時実行し hash 実装ズレを即検知。worktree 分離で衝突回避。
- **ドッグフーディング**：開発に使う Claude Code / Codex から、構築した MCP サーバー（`/mcp`）へ実接続してデモする。FR-026 の実証がテストを兼ねる（Phase 11）。

### day1 hard gate と tripwire（サマリ）

- **09-04 終業までに T018–T021 の結果を確定**（ネイティブ HBAR value 挙動 / MCP on Workers / R-2 の x402〔Blocky402 が value 付き ContractCall を扱えるか〕/ `apps/cdk` Graph Node）。これが 9 日プランの前提。
- primary 不成立 → `payFor` + `RightsRegistry.finalize` fallback（Complexity Tracking の条件付き行が発効、非原子を README 開示）。
- KeyGate 本命が Phase 7 で green にならない → `fallback.ts`（T077）に固定、README 開示。
- オンチェーン 20 並列が demo で不安定 → `AttackCounter` は DO 層の拒否を主表示、T034 を証拠併記。
- 審査員のライブ MCP 接続が不安定 → その区間のみ事前録画。
