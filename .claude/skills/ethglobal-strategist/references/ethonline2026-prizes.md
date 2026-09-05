# ETHOnline 2026 スポンサー賞 完全ブレイクダウン

**出典:** https://ethglobal.com/events/ethonline2026/prizes （2026-09-03 時点で WebFetch 確認）
**合計:** 公式掲載 11 パートナー・**約 $79,500**（The Graph 15k / Hedera 15k / Arc 10k / World 7k / 1inch 7k / ENS 5k / Uniswap Foundation 5k / Ledger 5k / Privy 5k / Bazantic 3k / Chainlink 2.5k）。ETHGlobal 本体の Finalist / Pool 賞は別枠の可能性があり要確認。

> **数字・トラック名は原文のまま**（賞の正式名称・SDK 名は公開契約として扱う）。要件は要約。最終判断は必ず公式ページを直接確認すること。

---

## The Graph — $15,000

> **チェーン依存の落とし穴：** 両トラックとも「**Consume live data from a Graph provider（Subgraph Studio / The Graph Market）。Mocked, local-only, or static datasets do not qualify.**」が要件。**自前ホストの Graph Node は "local-only" 扱いで要件を満たさない。** つまり **Subgraph Studio 非対応チェーン（2026-09 時点で Hedera 等）を選ぶと The Graph の賞は狙えない。** The Graph Token API も対応チェーンが限られる（Ethereum / Base / Arbitrum / BSC / Optimism / Polygon / Unichain / TRON / Solana 等）。チェーン選定時に必ず Subgraph Studio の対応表を確認すること。

| トラック | 金額 | 内訳 | 要件の要点 |
|---|---|---|---|
| **Best Use of Composable or Standardized Graph Products** | $5,000 | 1st $2,500 / 2nd $1,500 / 3rd $1,000 | The Graph 製品を **2 つ以上組み合わせる**、または標準スキーマ上に意味のある形で構築。Subgraph Studio または The Graph Market の **ライブデータ消費が必須**。単一 Subgraph を query しただけは不可。公開リポジトリ + デモ動画（2〜4 分）。 |
| **Best AI Tooling or AI Use Case with The Graph (From Scratch)** | $5,000 | 1st $2,500 / 2nd $1,500 / 3rd $1,000 | The Graph を **load-bearing（本体インフラ）** として使う。ライブデータ消費必須。データに対する「推論・意思決定・自動化・自然言語インターフェース」など **意味のある処理** を実演。OSS コード + README/SKILL.md。**公式に「THIS TRACK IS THE FROM SCRATCH TRACK」と明記**＝新規プロダクト専用（Continuity 限定ではない）。 |
| **Best AI Tooling or AI Use Case with The Graph (Continuity)** | $5,000 | 1st $2,500 / 2nd $1,500 / 3rd $1,000 | 上と同要件。ただし既存 OSS プロジェクト / プロダクト機能拡張が対象。 |

## Hedera — $15,000

| トラック | 金額 | 内訳 | 要件の要点 |
|---|---|---|---|
| **AI & Agentic Payments on Hedera** | $6,000 | 最大 3 チーム 各 $2,000 | **x402 ゲート付きサービス**を Hedera testnet/mainnet 上で **Blocky402 facilitator 経由**でホスト。消費側のプラットフォーム/エージェントが **実際の有料リクエストを end-to-end で完了**。公開 GitHub（README にセットアップ・アーキテクチャ・支払いフロー）。デモ動画（最大 5 分）。 |
| **Tokenization of Anything** | $6,000 | 最大 3 チーム 各 $2,000 | **Asset Tokenization Studio**（SDK / コントラクト / Web アプリ）でトークン化資産を発行・管理。Hedera testnet へデプロイ。**HashScan でコントラクト verify**。デモ動画（最大 5 分、発行・設定・ライフサイクル操作を提示）。 |
| **Open Source — Improve the Hedera Harness** | $2,000 | 最大 2 チーム 各 $1,000 | Hedera Harness への意味ある貢献（PR で可）、または着想を得た新規 harness。公開 GitHub/PR + README。デモ動画（最大 5 分）。 |
| **Continuity** | $1,000 | — | 過去ハッカソンのプロジェクトが対象。**実質的な新規作業**（新機能・Hedera サービス統合・アーキテクチャ変更）。磨き込み・バグ修正だけは不可。旧作業と新作業を明確に分離。 |

## Arc — $10,000

| トラック | 金額 | 内訳 | 要件の要点 |
|---|---|---|---|
| **Launch on Arc Testnet & Push to Mainnet** | $3,500 | 1st $2,500 / 2nd $1,000 | 動作する MVP + アーキテクチャ図 + 動画 + リポジトリ。**9/30 までに Arc mainnet へデプロイ済み or デプロイ可能状態**。 |
| **Best DeFi/Onchain Finance Application** | $1,667 | — | 動作 MVP + アーキ図 + 動画 + リポジトリ。Arc と USDC の意味ある活用（条件付き支払い・オンチェーン自動化・多段決済など「advanced programmable money flows」）。 |
| **Best Agentic Economy Application with Circle Agent Stack** | $1,667 | — | 同上フォーマット。「実シグナルに紐づく明確な意思決定ロジックを持つエージェント」＋「USDC を使った自律的な支出・支払い・決済フロー」。 |
| **Best DeFi or Agentic Application (Continuity)** | $1,666 | — | Continuity Project として登録。他 3 トラックと同フォーマット。 |
| **Launch on Arc … (Continuity)** | $1,500 | — | 上記 Launch トラックの既存プロジェクト版。 |

## World — $7,000

| トラック | 金額 | 要件の要点 |
|---|---|---|
| **AgentKit Continuity** | $3,500 | AgentKit を意味ある形で使用。動作アプリ必須。該当時は AgentBook でエージェント登録/解決。World ID Sandbox App 使用。**フィードバック文書提出必須**（AgentKit ドキュメント・Developer Portal・Sandbox App の分かりにくい/欠落/壊れている点）。 |
| **Selfie Check** | $3,500 | Selfie Check を「リスク・資格・公平性・継続性・不正防止シグナル」として意味ある形で使用。動作アプリ + Sandbox App + フィードバック文書。 |

## 1inch — $7,000

| トラック | 金額 | 内訳 | 要件の要点 |
|---|---|---|---|
| **Build an Aqua App** | $5,000 | 1st $2,500 / 2nd $1,500 / 3rd $1,000 | 公式 Aqua/SwapVM コントラクト使用。オンチェーンのトークン移動実行（ローカルフォーク可）。**まともな Git コミット履歴**（単一コミット提出は不可）。SwapVM 利用は高スコア。テスト or UI で「洗練された DeFi ポジション」を実演。 |
| **Build an Aqua App — Continuity** | $2,000 | 1st $1,500 / 2nd $500 | 既存プロジェクト版。同要件。 |

## ENS — $5,000

| トラック | 金額 | 内訳 | 要件の要点 |
|---|---|---|---|
| **Best Use of ENSv2** | $4,500 | 1st $1,500 / 2nd $1,500 / 3rd $1,000 / Runner-Up $500 | **ENSv2（Sepolia）** 上に構築。ENSv2 機能が「製品の中心。装飾的な付け足しは不可」。ハードコード値なしの動作デモ。動画 or ライブデモ。OSS コード。 |
| **Best Integration of ENSv2 into an Existing Project (Continuity)** | $500 | — | 既存プロジェクトの testnet に ENSv2（Sepolia）統合。動作デモ + 動画 + OSS。 |

## Uniswap Foundation — $5,000

| トラック | 金額 | 内訳 | 要件の要点 |
|---|---|---|---|
| **Best Uniswap Stack Contribution** | $3,000 | 最大 3 チーム 各 $1,000 | Uniswap stack（API / AMM v2・v3・v4 / CCA / hooks / extensions / tooling）上に構築 or 統合。公開 GitHub + OSS + **FEEDBACK.md**。Uniswap Developer Feedback Form 提出（FEEDBACK.md リンク付き）。 |
| **Best Uniswap Stack Contribution (Continuity)** | $2,000 | 1st $1,000 / 2nd $1,000 | 既存プロジェクト版。 |

## Ledger — $5,000

| トラック | 金額 | 内訳 | 要件の要点 |
|---|---|---|---|
| **AI Agents x Ledger** | $3,500 | 1st $2,000 / 2nd $1,000 / 3rd $500 | Ledger Agent Stack（**Ledger Key Ring CLI = `wallet-cli ring`**）上に構築。「デバイスに裏打ちされたセキュリティが製品の中心」。例：漏らせない秘密を使うエージェント、USB ポートのないホストでの Key Ring、Ledger 保護フローで API 支払いするエージェント、human-in-the-loop 承認。 |
| **Continuity** | $1,500 | 1st $1,000 / 2nd $500 | 既存プロジェクト拡張。Ledger Agent Stack 統合（DMK skills signer / Key Ring backend / device confirmation）。GitHub + デモ動画（最大 5 分）。 |

## Privy — $5,000

| トラック | 金額 | 要件の要点 |
|---|---|---|
| **Best B2B Financial Product** | $2,500 | Privy を中核統合。Privy ウォレットを最低 1 つ作成/使用。ビジネス/組織のユースケース。機能する B2B ワークフロー（支払い・承認・トレジャリー操作・ウォレット管理）。**Privy control を最低 1 つ**（policies / signers / key quorums / intents）。動作デモ + ソースコード。 |
| **Best Financial Flow** | $2,500 | Privy を中核統合。Privy ウォレット最低 1 つ。完結した金融フロー（transfers / bridging / stablecoin 変換 / swaps / Earn vaults / onramps のいずれか）。動作デモ + ソースコード。 |

## Bazantic — $3,000

| トラック | 金額 | 内訳 | 要件の要点 |
|---|---|---|---|
| **Best Recipe Using EthGlobal Hackathon Sponsor APIs** | $1,000 | 1st $500 / 2nd $300 / 3rd $200 | bazantic.com アカウント。**x402/MPP Gateway をデプロイ**。他スポンサー API を最低 1 つ使用。動作する多段 Recipe。完了タスクの画面録画。Bazantic ユーザー名提出。 |
| **Agentify a New API** | $1,000 | 1st $500 / 2nd $300 / 3rd $200 | イベント開始時点で未提供の API を Bazantic に追加。動作 Gateway + Recipe + 画面録画。 |
| **Help an Agent Use Your Hackathon Project (Continuity)** | $1,000 | 最大 2 チーム 各 $500 | x402/MPP Gateway デプロイ。Recipe 作成。生 API と Recipe 誘導結果を比較して改善を提示。動画。 |

## Chainlink — $2,500

| トラック | 金額 | 内訳 | 要件の要点 |
|---|---|---|---|
| **Best Confidential Workflow** | $2,000 | 最大 2 チーム 各 $1,000 | **CRE Workflow** を Confidential Workflows で構築。confidential TEE handler を登録・使用。機密部分が「センシティブな入力・シークレット・機密 API レスポンス・private パラメータ・中間値の少なくとも 1 つを enclave 内で処理」。CRE CLI シミュレーション or ライブデプロイを動画/端末出力で実演。 |
| **Best Chainlink-Powered Upgrade (Continuity)** | $500 | — | 既存アプリに Chainlink（CRE / Price Feeds / Data Streams / Proof of Reserve / VRF）統合。統合が「オンチェーンの state change に寄与」。 |

---

## 横断メモ

- **Continuity トラックが各スポンサーに用意されている** — 過去 ETHGlobal 作品の持ち込み拡張が明示的に歓迎される回。ただし「新規作業の実体」が必須で、旧/新の分離ドキュメントが要る。
- **フィードバック文書提出が賞要件のスポンサーが複数**（World 両トラック、Uniswap の FEEDBACK.md、The Graph の README/SKILL.md）。提出物チェックリストに必ず入れる。
- **デモ動画の長さ規定がスポンサーごとに違う**（The Graph 2〜4 分、Hedera/Ledger/Bazantic 最大 5 分）。ETHGlobal 本体の提出動画は 2〜4 分（`ethonline2026-rules.md` 参照）。最も厳しい制約に合わせる＝ **2〜4 分で作る**。
- **x402 が 3 スポンサーに絡む**（Hedera の Blocky402、Bazantic の x402/MPP Gateway、間接的に Arc の Circle Agent Stack）。x402 を軸にすると複数賞を一度に狙える。
