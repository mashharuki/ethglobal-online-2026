# TrueCollective × ETHOnline 2026 賞金適合分析

`docs/idea.md` §16（v1.7）と `specs/001-rights-runtime-mvp/` のアーキテクチャを、`ethonline2026-prizes.md` の各トラック要件と突き合わせた狙い目分析。

**役割分担（D1）：** `docs/idea.md` §16 = トラック選定と理由（戦略意図・正典）／ このファイル = 要件チェックリスト・不足・提出前チェック（実行詳細）。**食い違ったら §16 の選定が正、このファイルの要件詳細が正。**

TrueCollective の構成要素：Hedera 上の RightsNFT / RightsRegistry / RevenueSplitter、x402 Access Gateway（KeyGate 分散鍵）、EIP-712 Rights Receipt、Rights Graph（自前ホスト subgraph）、MCP サーバー（discover / buy / decrypt の 3 ツール、Cloudflare Workers、決済は Privy server wallet）、独占データセット ×2 を復号後に AI が分析するデモ。

---

## submit する3枠（partner prize はルール上 提出時 最大3枠）

### ① Hedera「AI & Agentic Payments on Hedera」— $6,000 ／ 現実的 〜$2,000（最大3チーム各$2,000）／ 適合度 5/5

| 要件（`ethonline2026-prizes.md`）| TrueCollective の充足 | 宿題 |
|---|---|---|
| x402 ゲート付きサービスを Hedera testnet/mainnet で **Blocky402 facilitator 経由**ホスト | Access Gateway（Hono on Cloudflare Workers）を Hedera Testnet に対して稼働。`RightsRegistry.settleAndIssue` が決済〜Receipt〜分配（§6.3）| day1（T053）で **Blocky402 が `settleAndIssue` への ContractCall ペイロードを settle できるか**確認。不可なら `finalize` fallback（非原子を README 開示、FR-008） |
| 消費側プラットフォーム/エージェントが**実際の有料リクエストを end-to-end 完了** | MCP エージェント（Claude Code / Codex）が `buy_access` → `ReceiptIssued` → `decrypt_content`（§12.1・v1.6）| CI ハーネス（T098）＋ ライブデモで実証 |
| 公開 GitHub、README にセットアップ・アーキテクチャ・支払いフロー | T118 | Blocky402 経由であることを明記（T053・T125）|
| HashScan でコントラクト verify | T027 | `RightsNFT` / `RightsRegistry` を verify |
| デモ動画（最大5分）| T127（2〜4 分で作る＝全スポンサー最小規定）| — |

### ② Privy「Best Financial Flow」— $2,500 ／ 適合度 4/5

| 要件 | 充足 | 宿題 |
|---|---|---|
| Privy を中核統合、Privy ウォレット最低1つ | web の所有者・購入者は `@privy-io/react-auth` 内蔵 EOA（T043）。MCP 決済は Privy server wallet（T126）| — |
| **完結した金融フロー**（transfers / stablecoin 変換 / swaps / onramps 等のいずれか）| x402 USDC 決済 ＝ stablecoin の支払いフローが購入→Receipt→収益分配→claim まで完結 | 「Privy が金融フローの中核」と見える導線に（単なる署名役に見せない）|
| 動作デモ + ソースコード | T091 / T093 / T078 | — |

### ③ Privy「Best B2B Financial Product」— $2,500 ／ 適合度 4/5

| 要件 | 充足 | 宿題 |
|---|---|---|
| Privy を中核統合、Privy ウォレット最低1つ | 同上 | — |
| **Privy control を最低1つ**（policies / signers / key quorums / intents）| **MCP 決済ウォレット = Privy server wallet の session signer + spend policy**（method allowlist ＝ `RightsRegistry` 決済関数 + USDC `approve` のみ、1 セッション支出上限、レート制限。T126 / FR-028 / SC-011）| day1（R-9）で Cloudflare Workers から Privy server wallet を呼べるか確認 |
| ビジネス/組織のユースケース、機能する B2B ワークフロー | Creator = 独自データを売るデータプロバイダのトレジャリー運用（収益分配・claim）。AI エージェントが B2B 的に自律決済 | B2B の位置づけを README / 動画で明示 |
| 動作デモ + ソースコード | T126 のテスト（`mcpWalletPolicy.spec.ts`）+ ライブデモ | — |

**現実的獲得見込み合計：$5,000〜7,000**（プール総額 $23,500 とは別物。pitch では分けて表記）。

---

## The Graph は submit しない（Rights Graph は技術要素として維持）

| 事実 | 出典 |
|---|---|
| 両 Graph トラックが「Consume live data from a **Graph provider**（Subgraph Studio / The Graph Market）。**Mocked, local-only, or static datasets do not qualify.**」を要件 | `ethonline2026-prizes.md`、prizes ページ原文（2026-09-04 確認）|
| **Hedera は Subgraph Studio / The Graph Market / The Graph Network に非対応** ― 自前 graph node が必須 | Hedera 公式ドキュメント |
| **The Graph Token API も Hedera 非対応**（対応：Ethereum / Base / Arbitrum / BSC / Optimism / Polygon / Unichain / TRON / Solana 等）| The Graph docs |
| 自前ホスト Graph Node（AWS Lightsail 等）は "a Graph provider" ではなく "local-only" 扱い | 要件の文言 |

→ **v1.3 の「Hedera 一本化」と The Graph の賞は構造的に両立しない。** `docs/idea.md` §16.4 の「The Graph×Hedera 検証済み」はローカル graph node での確認であり、賞要件を満たす経路ではなかった。

**維持するもの：** Rights Graph（subgraph）は `RightsNFT` / `RightsRegistry` のイベントを index し、**Agent の資産発見（FR-020）と Dashboard の監査ビュー**に使う load-bearing な技術要素。AWS Lightsail 等の自前 Graph Node（docker-compose）で運用。day1（T054）に Subgraph Studio の Hedera 対応を再確認 ― 万一対応済みなら submit 対象を再検討。

---

## 見送り（`docs/idea.md` §16.3 と一致）

| スポンサー / トラック | 見送り理由 |
|---|---|
| **The Graph（両トラック $15,000）** | Hedera 非対応（上記）|
| **Hedera「Tokenization of Anything」$6,000** | Asset Tokenization Studio 統合が `RightsNFT._update` override（`accessEpoch` 自動 +1）と相性が悪くスコープ外 |
| **Bazantic $3,000** | v1.7 で見送り |
| Arc（Circle）$10,000 | Privy と役割重複、Circle Agent Stack 固有機能・9/30 mainnet デプロイ要件が重い |
| World $7,000 | 匿名所有証明の将来拡張（§3.2）と相性◎だが MVP 後回し、フィードバック文書 + Sandbox の工数 |
| Chainlink $2,500 / Ledger $5,000 | v1.3 で計画から削除済み |
| ENS $5,000 | 「ENSv2 が製品の中心」要件・Sepolia がスコープ拡大 |
| 1inch $7,000 / Uniswap Foundation $5,000 | DeFi 化で製品の焦点が崩れる |

---

## 提出前チェックリスト（3枠共通）

- [ ] 公開 GitHub リポジトリ（コミット履歴が 2026-09-04 から連続。単一巨大コミット禁止）
- [ ] README：セットアップ・アーキテクチャ・x402 支払いフロー・信頼モデル段落（T118）
- [ ] README：**事前作業の明示的開示** ― `hedra-sample`（公開の汎用ボイラーテンプレート、TrueCollective 固有ロジックは含まない）／`specs/` `.specify/`（2026-09-02〜03 作成、spec-driven ＝ ETHOnline AI ポリシー準拠）
- [ ] README：MCP エンドポイント URL と `mcp.json` スニペット（審査員が非同期で試せるように、FR-027）
- [ ] Spec Kit 成果物（`specs/NNN-*/`）と AI プロンプトをリポジトリに同梱
- [ ] From Scratch 自己監査：全 TrueCollective 固有ファイルの初回コミットが 09-04 以降（`git log`、T125）
- [ ] デモ動画 **2〜4 分**・720p・話者ナレーション（TTS/AI 音声禁止）・速度操作なし・スライド箇条書き4点以内（T127）
- [ ] Hedera：コントラクトを HashScan で verify、**Blocky402 facilitator 経由**であることを明示
- [ ] Hedera：MCP エージェントが実際の有料リクエストを end-to-end 完了する様子を動画に
- [ ] Privy：完結した金融フロー（stablecoin）を中核に据えた構成（Best Financial Flow）
- [ ] Privy：MCP 決済ウォレットに session signer + spend policy を適用し、上限超過が拒否される様子（Best B2B Financial Product、SC-011）
- [ ] partner prize は提出時に 3 つ選択：Hedera「AI & Agentic Payments」／ Privy「Best Financial Flow」／ Privy「Best B2B Financial Product」
- [ ] ライブ審査進出時：`pitch/qa.md`（T128）でリハーサル

---

## デモの WOW モーメント（審査基準「WOW Factor」直撃）

1. **審査員自身の Claude Code / Codex から MCP サーバーに接続**し、その場で資産発見 → x402 購入 → 復号 → 分析まで自律実行させる（v1.6 のリモート MCP）。**ライブ接続が不安定なら事前録画区間で見せ、URL を提示**（I16）。
2. **1 回の A→B 移転**で「A のオーナーセッション即時失効（`OWNER_EPOCH_MISMATCH`）」と「第三者の `SURVIVE_TRANSFER` 有料ライセンス存続」を並べて表示（v1.5 で必須）。
3. **Cross-Resource 攻撃の失敗実演**：資産 A の Receipt で資産 B を開こうとして弾かれる（独占データセット ×2 の理由）。
4. **20 並列 Replay**：アプリ層で 19 件が `RECEIPT_ALREADY_CONSUMED` で <3s 拒否、成功 1 件は on-chain 確定（ライブカウンタ表示）。
