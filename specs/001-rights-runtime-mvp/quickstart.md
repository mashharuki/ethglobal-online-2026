# Quickstart / 検証ガイド: Transfer-Coupled Rights Runtime MVP

このガイドは **feature が end-to-end で動くことを証明する手順** を示す。実装の詳細（モデル・サービス本体・マイグレーション・テスト全文）は `tasks.md`（`/speckit-tasks`）と実装フェーズに属する。

参照：[plan.md](./plan.md)・[data-model.md](./data-model.md)・[contracts/](./contracts/)。

---

## 0. 前提（day1 セットアップ）

| 必要なもの | 取得元 |
|---|---|
| Node.js 22 LTS / pnpm 9+ | — |
| Hedera Testnet アカウント × 5（operator / creator / owner-A / owner-B / buyer） | https://portal.hedera.com（`0.0.x` + ECDSA 秘密鍵）。MCP の決済ウォレットは下記 Privy が管理 |
| Testnet HBAR（gas） | Hedera Portal faucet |
| Testnet HBAR を各アカウントへ（buyer / agent は決済分も） | Hedera Portal faucet。**決済資産はネイティブ HBAR**（Blocky402 facilitator が `hedera:testnet` でサポートするのはネイティブトークン、HTS USDC ではない ― `/supported`。R-2 / R-4）。token association 不要 |
| `HEDERA_RPC_URL`（JSON-RPC relay） | `https://testnet.hashio.io/api`（HashIO）など |
| Cloudflare アカウント + `wrangler login` | `apps/gateway`（Workers / DO / KV / Hyperdrive）と `apps/web`（Pages）のデプロイ |
| PostgreSQL（Neon / Supabase 無料枠） | Hyperdrive のバックエンド。`HYPERDRIVE_URL` を `wrangler hyperdrive create` で発行 |
| Anthropic API キー | CI 検証ハーネスの実推論用（`ANTHROPIC_API_KEY`） |
| Web3.Storage / Pinata トークン | 暗号文・プレビューの IPFS ピン |
| Privy App（Server SDK 有効化） | MCP 決済ウォレットの session signer + spend policy（`PRIVY_APP_ID` / `PRIVY_APP_SECRET`、R-9 / FR-028）。web の `@privy-io/react-auth` と同一 App |
| AWS アカウント + `aws configure`（CDK 用） | `apps/cdk` が Rights Graph の自前 Graph Node（EC2 1 台 + docker-compose：`graph-node` + PostgreSQL + IPFS、Hedera JSON-RPC relay を provider に）を建てる。Subgraph Studio / Hosted Service は Hedera 非対応（R-5）。**ハッカソン期間のみ、終了後 `cdk destroy`**。The Graph の賞には submit しない |

```bash
git clone <repo> && cd truenft && pnpm install   # ワークスペース = apps/* + packages/*（cdk も apps/cdk）
cp .env.example .env                      # 上記を記入
pnpm --filter openapi generate           # packages/openapi/openapi.yaml → src/types.ts（gateway/web/agent が import）
pnpm run check                            # biome + knip + jscpd + tsc + redocly lint（全 workspace）

pnpm --filter contracts deploy:testnet    # apps/contracts：RightsNFT / RightsRegistry をデプロイ → packages/shared/src/addresses.ts 更新
pnpm --filter contracts seed:testnet      # デモ NFT 2 種を mint・Manifest 登録（下記）
# Faucet 残高でのデモ用：合計 11 HBAR を配布し、購入価格を 0.1 HBAR にする
pnpm --filter contracts seed:testnet:lean

# Rights Graph（自前 Graph Node を AWS へ。ハッカソン期間のみ）
# 8020 / 5001 / 8030 は指定した接続元IPだけに開放する。省略すると subgraph deploy は到達できない
pnpm --filter cdk run deploy -c allowedAdminCidr=<現在のグローバルIP>/32
export GRAPH_NODE_ADMIN=http://<ElasticIp>:8020/
export GRAPH_NODE_IPFS=http://<ElasticIp>:5001
pnpm --filter subgraph run create         # 初回のみ：truecollective/rights-graph を登録
pnpm --filter subgraph run deploy         # IPFS upload → graph deploy。startBlock はデプロイ tx から自動注入

# gateway（apps/gateway、Cloudflare Workers）
pnpm --filter gateway db:migrate          # Hyperdrive 経由 Postgres にマイグレーション
pnpm --filter gateway secrets:put         # RECEIPT_SIGNER_KEY / KV_KEK / HEDERA_OPERATOR_KEY / PRIVY_APP_ID / PRIVY_APP_SECRET を wrangler secret put（MCP 決済の生鍵は置かない ＝ Privy server wallet 管理。share_U は下記 load-shares で asset ごとに投入）
pnpm --filter gateway dev                 # wrangler dev（miniflare、:8787。DO / KV / Hyperdrive をローカルエミュレート、share_U は .dev.vars で代替）
# 本番: pnpm --filter gateway deploy       # wrangler deploy（空実装でも一度デプロイし、Worker を Cloudflare 上に存在させる）
# ⚠ 2026-09-05 追加（Codex #21 対応）：デプロイ済み Worker が無いと `wrangler secret put` は投入先が無く失敗する。
#   このため share_G / share_U の投入は必ず「初回 deploy の後」に行う：
pnpm --filter gateway load-shares         # apps/contracts/out/seed-artifacts.json（T048 の seed 出力）を読み、
                                           # share_G を KEK 暗号化して wrangler kv key put、share_U を wrangler secret put（asset ごと）
pnpm --filter gateway deploy              # 投入したシークレットを反映するため再デプロイ
# ⚠ 上記 3 行（初回 deploy → load-shares → 再 deploy）を飛ばすと、web/agent から復号可能な状態にならない
#   （share_G/share_U が存在しないため KeyGate が常に失敗する）。審査員が手順を追う際もこの順序を厳守すること。

# web（apps/web、Vite + Tailwind、Cloudflare Pages）
pnpm --filter web dev                     # :5173
# 本番: pnpm --filter web deploy            # wrangler pages deploy dist

# agent（apps/agent、CI 検証ハーネス）
pnpm --filter agent build

# API E2E（Postman コレクションを Newman で実行。デプロイ済み gateway + 実 Testnet に対して）
pnpm --filter e2e test:api               # newman run apps/e2e/postman/gateway.postman_collection.json（レスポンスが openapi.yaml に適合を assert）

# ハッカソン終了後
pnpm --filter cdk run destroy             # Graph Node インフラを撤去
```

**seed が作るデモデータ**
- `assetId=A`：独占データセット #1、`transferMode=SURVIVE_TRANSFER`、`price=5 HBAR`（weibar `5000000000000000000`）、`maxUses=5`、owner=A
- `assetId=B`：独占データセット #2、`transferMode=INVALIDATE_ON_TRANSFER`、`price=5 HBAR`、`maxUses=3`、owner=A
- `seed:testnet:lean` の場合のみ、両資産の価格は `0.1 HBAR`。creator / owner-A / owner-B / buyer / agent への配布は合計 `11 HBAR`。権利判定・収益分配ロジックは通常プロファイルと同一
- 各暗号文は `seed` がクライアント側 AES-256-GCM 暗号化して IPFS へ。`share_G` は gateway の Workers KV（KEK 暗号）、`share_U` は Workers Secrets Store（ローカルは `.dev.vars`）

---

## 1. 成功基準（§10.4 / SC-001〜012）の検証

各シナリオは `pnpm --filter e2e test <name>` で自動実行（Playwright + agent スクリプト + Hardhat）。手動確認用の手順も併記。

### SC-001 / SC-008 — 所有者アクセス（p50 < 8s、≤ 3 クリック）

```
1. web :5173 → Privy でログイン（owner-A のキーを import）      … クリック 1
2. Market で asset A を開く → "Access as owner"                  … クリック 2
3. Privy が KeyGateChallenge + OwnerAuthChallenge に署名           … クリック 3（署名）
   → POST /owner/keygate → share_G + blindedU 受領
   → web が K を復元し AES-256-GCM 復号 → データセット表示
```
**期待**：復号表示まで（署名待ち時間を除く）中央値 < 8s / p95 < 15s。操作 3 クリック以内。
**計測**：`apps/e2e/metrics.json` に `owner_access_ms` の分布。

### SC-002 — 購入者アクセス（p50 < 20s）

```
1. 非所有者ウォレットで asset A の /assets/A/paid を GET → HTTP 402
2. x402-fetch で部分署名ペイロードを付けて再送
   → gateway が RightsRegistry.settleAndIssue{value: price}（ネイティブ HBAR）を submit（1 Hedera tx、Blocky402 facilitator 経由）
   → ReceiptIssued 確認、receiptHash + serverSignature 受領
3. POST /keygate/share (path=licensee) → consume tx → share_G
4. web が復号・表示
```
**期待**：支払い開始 → 復号表示 中央値 < 20s / p95 < 40s（Hedera finality 3–5s × 2 tx を含む）。

### SC-003 — 移転 → 失効（< 10s、次の 1 アクセスで）

```
1. owner-A で asset A を復号成功（SC-001）
2. owner-A → owner-B へ RightsNFT transfer（accessEpoch 7→8）
3. owner-A が同じ画面で "Access as owner" を再実行
   → gateway: eth_call ownerOf(A) == owner-B ≠ owner-A → NOT_CURRENT_OWNER
4. owner-B が Privy 切替 → "Access as owner" → 成功（新 blindedU 生成）
5. 暗号文の CID を移転前後で比較 → 同一（再暗号化なし、FR-015 / User Story 1 シナリオ4）
```
**期待**：手順 3 の拒否が transfer 確定後 < 10s で反映。手順 5 で CID 一致。

### SC-004 / SC-010 — 14 攻撃ケース全件（突破 0）

`pnpm --filter contracts test` + `pnpm --filter gateway test` + `pnpm --filter e2e test attacks` + `pnpm --filter e2e test:api`（Newman：14 行の HTTP 断面と `code` / status の OpenAPI 適合）。
[contracts/error-codes.md](./contracts/error-codes.md) の 14 行それぞれに 1 テスト（憲章 IV：ガード実装前に書く）。**14 行 ＝ 拒否 13 種 ＋ 正常系 1 件（#12：`SURVIVE_TRANSFER` が移転後に拒否されないことの確認）**（C1）。

| # | 検証 | 期待 |
|---|---|---|
| 1 | 同じ `(receiptHash, useIndex)` を 2 回 | 2 回目 `RECEIPT_ALREADY_CONSUMED` |
| 2 | 20 並列（→ SC-005） | 成功 1・拒否 19・< 3s |
| 3 | asset A の Receipt で asset B へ | `RESOURCE_HASH_MISMATCH` |
| 4 | policy 改変 | `POLICY_HASH_MISMATCH` |
| 5 | 別 chainId で署名 | `CHAIN_ID_MISMATCH` |
| 6 | 別ウォレットの keyGateSig | `LICENSEE_MISMATCH` |
| 7 | `expiresAt` 経過後 | `RECEIPT_EXPIRED` |
| 8 | `maxUses` 超過 | `USE_LIMIT_EXCEEDED` |
| 9 | 必要額未満で settle | `UNDERPAYMENT`（tx revert） |
| 10 | 同 `paymentId` 別 body | `PAYMENT_ID_PAYLOAD_CONFLICT` |
| 11 | 移転後に旧セッション | `OWNER_EPOCH_MISMATCH` / `NOT_CURRENT_OWNER` |
| 12 | 移転後に `SURVIVE_TRANSFER` Receipt（asset A） | **成功**（拒否されないことを検証） |
| 13 | 移転後に `INVALIDATE_ON_TRANSFER` Receipt（asset B） | `LICENSE_INVALIDATED_ON_TRANSFER` |
| 14 | `bumpLicenseEpoch` 後に旧 Receipt | `LICENSE_EPOCH_MISMATCH` |

### SC-005 — Concurrent Replay（20 並列 → アプリ層で 19 拒否 < 3s、成功 1 は finality 後）

```
1. buyer が asset A の Receipt を取得（maxUses=5）
2. 同じ (receiptHash, useIndex=0) で POST /keygate/share を 20 並列
   （apps/e2e/attacks.e2e.ts が Promise.all で実発火。憲章 IV：逐次シミュレーション不可）
```
**期待**：アプリ層（DO / DB）で **19 件が `RECEIPT_ALREADY_CONSUMED` で拒否され、この判定が < 3s**。成功候補の 1 件はオンチェーン `consume` の確定（Hedera finality 3〜5s）で確定し、`consume` tx も 1 件のみ mined。最終的に成功はちょうど 1 件（SC-005・I8）。

### SC-006 — 収益分配（誤差 0）

```
1. asset A（creatorBps=3000 / ownerBps=7000）を price=3333333333333333333 weibar（端数の出る額）で購入
2. RightsRegistry.allocationOf(paymentId) を読む
```
**期待**：`creatorAmount + ownerAmount == 3333333333333333333`（dust ゼロ）。端数は規則どおり（treasury 未設定なら creator）に寄る。`claim()`（nonReentrant）後の各 HBAR 残高が一致。

### SC-007 / SC-009 — AI Agent 自律フロー（人手介入 0・実インフラ）

```bash
pnpm --filter agent run -- --question "どの区分が最も伸びたか、根拠の数値とともに答えよ"
```
Agent が自律で：`discover`（subgraph）→ `purchase`（x402、実ネイティブ HBAR、Blocky402 経由）→ `decrypt`（KeyGate）→ `analyze`（Claude tool-use、実推論）→ 回答を stdout + `apps/agent/out/answer.json`。
**期待**：一度の実行で回答まで到達。途中に人間の入力プロンプトが無い。決済・consume・復号・分析がすべて実インフラ（Testnet / 実 x402 / 実 Claude）。

### SC-009 — モック不在の確認

`pnpm run audit:no-mocks`：コア経路のソース（`apps/gateway/src/chain`, `apps/gateway/src/keygate/release.ts`, `apps/gateway/src/x402`, `apps/gateway/src/mcp/tools`, `apps/agent/src/analyze.ts`）に `mock` / `stub` / ハードコード応答が無いことを grep + CI で確認。モックは `docs/idea.md` §11.2 のスコープ外要素に限り許容し README に列挙。

### SC-011 — MCP 決済ウォレットのポリシー

`pnpm --filter gateway test mcpWalletPolicy`：セッション支出上限超過・allowlist 外メソッド呼び出しが拒否される（T068 / T092）。

### SC-012 — API 型の単一ソース（フロント/バック一致）

`pnpm --filter openapi generate` → `pnpm -r typecheck`：`openapi.yaml` を編集して片側だけ実装を変えると `tsc` が失敗する（生成型を gateway/web/agent が共有、FR-029）。`pnpm --filter e2e test:api`（Newman）で実デプロイのレスポンスが `openapi.yaml` に適合。

---

## 2. 3 分デモ台本（`docs/idea.md` §13.2）の通し（納品契約）

```
0:00 問題提起
0:20 Owner Epoch / License Epoch の説明（KeyGate ＝ NFT 所有権が鍵の一部）
0:40 owner-A で asset A を KeyGate 復号（SC-001）
1:10 asset A を owner-A→owner-B へ transfer。Dashboard の 2 分割画面：
      左）owner-A の（移転前セッションでの）再アクセス → OWNER_EPOCH_MISMATCH
      右）第三者の SURVIVE_TRANSFER ライセンス（asset A）→ そのまま復号成功
1:40 Claude Code / Codex を MCP 接続（※審査員接続区間は事前録画）：discover → 402
      → Hedera tx で決済+分配+ReceiptIssued（primary。不成立時は finalize 経路）→ Receipt
2:10 接続先 AI が KeyGate 復号 → データセットに分析回答（実 Claude）→ creator/owner-B へ分配（誤差 0）
2:30 攻撃：同 Receipt を 20 並列 Replay → ライブカウンタ「アプリ層 19 rejected / 成功 1（on-chain 確定）」
2:50 Sponsor Stack（Hedera / Privy）＋ Rights Graph（`apps/cdk` の AWS EC2 で自前ホスト）
      ＋ "Transfer the NFT. Transfer the rights. Not the vulnerabilities."
```

- 提出動画は 2〜4 分・720p・話者ナレーション必須・速度操作禁止（T127）。上記台本を分割収録して 09-12 にまとめる。
- ライブ審査進出時は 4 分デモ + 3 分 Q&A（想定問答は `pitch/qa.md`、T128）。

---

## 3. Definition of Done（`docs/idea.md` §20）チェック

状態列は 2026-09-06 時点（T124 の中間確認）。凡例: ✅ 充足 / 🟡 ローカル検証済み・ライブ未 / ⬜ 未着手。
ライブ検証（T099 / T119 / T121）が終わるまで 4・6・7 を ✅ にしない（README「Verification status」と同じ区別）。
提出直前に全行を再判定し、この表を最終状態に更新する。

| DoD | 対応する検証 | 状態（2026-09-06） |
|---|---|---|
| 1. 発明が一文で説明できる | デモ 0:20、`plan.md` Summary | ✅ README 冒頭・`docs/submission/showcase.md` の Tagline |
| 2. Ethereum（Hedera）の必然性 | `accessEpoch` は `_update` のみ、権利 anchor ＝決済 tx（R-2 primary。**不成立時は `finalize` 経路。いずれも `_update` 限定で必然性は保たれる**） | ✅ `RightsNFT._update` override と `RightsRegistry.settleAndIssue{value}` は contract suite で検証。レール（primary / custodial / fallback）の確定は day1 probe T020 待ち |
| 3. 既存作との差が明確 | KeyGate（再暗号化不要）＋ 二層 epoch の並置デモ（1:10） | 🟡 KeyGate と二層 epoch は gateway suite で検証済み。並置デモ（`splitScreen.e2e.ts`）はデプロイ先が無く skip |
| 4. 実装が本物 | SC-009（モック不在監査 + CI 実 Testnet ジョブ） | 🟡 `AUDIT_STRICT=1 bash scripts/audit-no-mocks.sh` が 5 core path 全 pass（PR #25）。実 Testnet ジョブは CI 配置と `HEDERA_OPERATOR_KEY` 待ち＝**ライブ未** |
| 5. 攻撃に耐える | SC-004（14 行 ＝ 拒否 13 + 正常系 1）、SC-005 | 🟡 contract 層の `AdversarialMatrix.t.sol` と gateway 層の adversarial / 20 並列 replay suite は green。実デプロイに対する `attacks.e2e.ts`（T116）は skip |
| 6. Sponsor 統合が深い | **submit 3 枠：Hedera「AI & Agentic Payments」（x402 ゲートを Hedera で実ホスト・Blocky402）／ Privy「Best Financial Flow」（決済フローの中核）／ Privy「Best B2B Financial Product」（MCP 決済ウォレットの Privy server wallet + per-session spend cap）**。Rights Graph（自前 Graph Node）は Agent 発見・監査で load-bearing だが Graph の賞には submit しない（Hedera が Subgraph Studio 非対応、R-5） | 🟡 統合はコードとして存在しローカル検証済み。Hedera 実ホスト・HashScan verify・Privy 実ログインは**ライブ未**。B2B 枠の「Privy control」は要判断（`docs/submission/prize-requirements.md` §3） |
| 7. 提出が透明 | README に信頼モデル段落（`docs/idea.md` §9.1）・**事前作業の明示的開示（`hedra-sample` 含む）**・AI 使用・Git 履歴（実装コミットは 09-04 以降）・提出動画は規定準拠（T127） | 🟡 README の信頼モデル / 事前作業開示 / AI 使用は記載済み。From Scratch 自己監査は 09-04 より前の初回コミット 0 件を実測（`docs/submission/prize-requirements.md` §4）。**動画（T127）は未**。ライブ未検証項目を README で skip 明示している限り「透明」は保てるが、✅ は動画と最終監査の後 |

---

## 4. 既知のリスクとフォールバック（day1 で判断）

| リスク | フォールバック |
|---|---|
| Blocky402 facilitator が value 付き ContractCall 非対応（R-2、day1 T020） | `payFor` + permissionless `RightsRegistry.finalize` 経路へ。README と FR-008 で「決済と anchor は非原子（HBAR は非 custody・permissionless finalize・timeout 返金）」と開示 |
| KeyGate 本命（`share_G` XOR）が間に合わない（R-1、Phase 7 判定） | Gateway が短命署名 URL を返す素の方式（T077）。README で「この構成では Gateway が平文を扱う」と開示 |
| Subgraph Studio が Hedera 非対応（確定。day1 に再確認のみ） | **`apps/cdk`（AWS CDK）で建てた AWS EC2 + docker-compose の自前 Graph Node で Rights Graph を運用**（ハッカソン期間のみ、終了後 `cdk destroy`）。The Graph の賞トラックには submit しない（発見・監査の技術要素として維持）。最終手段は Hedera Mirror Node + 自前 indexer |
| `apps/cdk` の Graph Node が Hedera relay と同期しない / EC2 リソース不足（day1 T021） | インスタンスを 1 段上げて再 `cdk deploy`。それでも不安定なら Dashboard を `subgraph_cache` + Mirror Node フォールバック表示に切替（Rights Graph は発見・監査のみ、認可には不使用） |
| MCP のライブ接続がデモ環境で不安定（I16） | 審査員接続区間は事前録画（T127）。README に `mcp.json` を掲載し非同期で試せるように（FR-027） |
