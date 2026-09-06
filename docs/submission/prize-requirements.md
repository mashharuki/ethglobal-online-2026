# 提出物チェック：partner prize 3 枠の要件充足と From Scratch 自己監査（tasks.md T126）

作成 2026-09-06。要件の出典は `.claude/skills/ethglobal-strategist/references/ethonline2026-prizes.md`
（2026-09-04 に公式 prizes ページから転記）と同 `ethonline2026-rules.md`。**状態列は本日時点の
スナップショット**であり、ライブ状態（デプロイ済みか・HashScan verify 済みか）の現在値は
GitHub / HashScan / Cloudflare 側で引き直すこと（この文書を更新して ✅ にするのは実測後）。

状態の凡例: ✅ 充足（実測済み） / 🟡 ローカル検証済み・ライブ未 / ⬜ 未着手 / ❗ 要判断

## 1. Hedera「AI & Agentic Payments on Hedera」（$6,000・最大 3 チーム各 $2,000）

| 要件 | 状態 | 根拠 / 残作業 |
|---|---|---|
| x402 ゲート付きサービスを Hedera testnet/mainnet で **Blocky402 facilitator 経由**でホスト | 🟡 | `apps/gateway/src/x402/facilitator.ts` が Blocky402 の `/supported` `/verify` `/settle` を呼ぶ。`wrangler.toml` の `X402_FACILITATOR_URL=https://api.testnet.blocky402.com`。**残作業**: `pnpm --filter gateway deploy`（T097）と day1 probe（T020）でレールを確定（`SETTLEMENT_MODE` は custodial 既定・primary/fallback は probe 結果次第、`apps/gateway/CONFIG.md`） |
| 消費側エージェントが**実際の有料リクエストを end-to-end 完了** | 🟡 | MCP 3 ツールと session 束縛・支出上限は gateway の unit suite で green（実 MCP SDK transport）。**残作業**: `apps/agent` の自律 run（T121、`ANTHROPIC_API_KEY` + デプロイ済み gateway 必要）を実走し、動画に収める |
| 公開 GitHub、README にセットアップ・アーキテクチャ・支払いフロー | ✅ | README「How a purchase works (x402, native HBAR)」「Repository layout」「Deploy」。repo は public |
| HashScan でコントラクト verify（`RightsNFT` / `RightsRegistry`） | ⬜ | `packages/shared/src/addresses.ts` の `DEFAULT_DEPLOYMENT` は未デプロイ（ゼロアドレス）。**残作業**: T047 deploy → `pnpm --filter contracts verify:testnet`（Sourcify 経由・`hardhat.config.ts` の `verify.sourcify`）→ README と `showcase.md` にアドレスを記載 |
| デモ動画（最大 5 分） | ⬜ | T127。全スポンサー共通の 2〜4 分規定で作る |

## 2. Privy「Best Financial Flow」（$2,500）

| 要件 | 状態 | 根拠 / 残作業 |
|---|---|---|
| Privy を中核統合・Privy ウォレット最低 1 つ | 🟡 | web: `@privy-io/react-auth` embedded EOA（`apps/web/src/x402/privyHederaSigner.ts` が Hedera 送金を Privy で署名）。gateway: `@privy-io/node` server wallet（`apps/gateway/src/mcp/wallet.ts`）。**残作業**: Privy App の実ログイン（E2E は `E2E_PRIVY_EMAIL/OTP` で skip 中） |
| 完結した金融フロー（transfers / stablecoin 変換 / swaps / onramps 等） | 🟡 | **native HBAR の transfer** として x402 支払い → `settleAndIssue{value}` → 収益分配（creator/owner bps） → Receipt → 復号まで一気通貫（憲章 v1.3.0 で USDC から native HBAR に変更済み。要件文言の「transfers」に該当）。**残作業**: ライブで 1 回通す（T099 / T119） |
| 動作デモ + ソースコード | ⬜ / ✅ | 動画は T127。ソースは public |

## 3. Privy「Best B2B Financial Product」（$2,500）

| 要件 | 状態 | 根拠 / 残作業 |
|---|---|---|
| Privy を中核統合・Privy ウォレット最低 1 つ | 🟡 | 上と同じ（server wallet が MCP の支払い主体・licensee） |
| ビジネス/組織のユースケース・機能する B2B ワークフロー | 🟡 | データプロバイダ（creator）が AI エージェント（B2B の買い手）へ有料ライセンスを自動販売、収益は creator/owner に分配。README「AI agent through MCP」 |
| **Privy control を最低 1 つ**（policies / signers / key quorums / intents） | ❗ | **現状の実装は「Privy server wallet が署名者（signer）で、生鍵は gateway に無い」＋「支出上限は gateway 側の per-session cap（`MCP_SESSION_SPEND_CAP_TINYBAR`、`mcp/session.ts`）」**。`wallet.ts` のコメントどおり、Hedera の tx digest を `secp256k1_sign` する raw-hash 署名には Privy の policy が評価できる tx 構造が無く、**Privy 側の policy / key quorum / authorization key は未設定**（`grep -rEi 'authorization|quorum|policy' apps/gateway/src/mcp` で 0 件）。**判断が必要**: (a) 「server wallet = signer」を Privy control として主張し README の開示（CONFIG.md 参照）を前面に出す、または (b) server wallet に Privy の authorization key（key quorum）を付けて署名要求に gateway の認可署名を必須化する＝raw-hash 署名でも成立する正真の Privy control（実装は wallet 作成時の `owner` / authorization key 設定＋署名 RPC への authorization signature 付与。工数は小〜中、day1 の R-9 検証と同じ経路）。**推奨は (b)**。要件文言に「signers」が含まれるため (a) でも読める余地はあるが、審査員に「Privy の policy を使っていない」と見られるリスクが残る |
| 動作デモ + ソースコード | ⬜ / ✅ | 上限超過が拒否される様子（SC-011）を動画に。unit suite では `should reject a purchase over the per-session cap before signing anything` が green |

## 4. From Scratch 自己監査（tasks.md T126・憲章「事前作業の開示」）

実測コマンドと結果（2026-09-06、origin/main 669c4dc）:

```bash
git log --reverse --format='%ad %h %s' --date=iso-strict | head -3
# 2026-09-05T07:28:29+09:00 5e927c8 Initial commit
# 2026-09-05T07:35:30+09:00 25c0374 init
# 2026-09-05T08:49:51+09:00 b305c5c add configs
```

```bash
git log --diff-filter=A --name-only --format='DATE %ad' --date=short \
  | awk '/^DATE/{d=$2;next} NF{if(!($0 in s)) s[$0]=d} END{for(f in s) if(s[f]<"2026-09-04") print s[f], f}'
# （出力なし ＝ 2026-09-04 より前に初回コミットされたファイルは 0 件）
```

- リポジトリ履歴の初回コミットは 2026-09-05 07:28 JST（イベント開始 09-04 以降）。tracked ファイルで
  09-04 より前に追加されたものは 0 件。
- ただし README「Prior work and disclosure」のとおり、これは**コミット時刻の事実**であって著作の
  事実ではない。`specs/` `.specify/` の設計文書は 2026-09-02〜03 に Spec Kit で作成（AI ポリシー上
  許容）、`hedra-sample` 由来の公開ボイラープレート（Hardhat ERC-721 mint / subgraph example /
  x402 + Privy web sample）はイベント前から存在し TrueCollective 固有ロジックを含まない。
  この 2 点は README に開示済み。
- 提出前に main の履歴が「連続した小さなコミット」であること（単一巨大コミット禁止）を
  `git log --oneline main | wc -l` と PR 一覧で再確認する。

## 5. 提出時チェックリスト（全枠共通・`truecollective-prize-fit.md` と同期）

- [ ] 公開 GitHub、コミット履歴が 2026-09-05 から連続
- [x] README: セットアップ / アーキテクチャ / x402 支払いフロー / 信頼モデル段落 / 事前作業の開示 / AI 使用の明記 / `mcp.json` スニペット
- [ ] README・`showcase.md` の `<placeholder>`（gateway URL / web URL / コントラクトアドレス / 動画 URL）を実値に更新
- [ ] Spec Kit 成果物（`specs/001-rights-runtime-mvp/`、`.specify/`）を同梱（現状 tracked）
- [ ] From Scratch 自己監査を提出直前にもう一度実行（§4 のコマンド）
- [ ] デモ動画 2〜4 分・720p・話者ナレーション・TTS/AI 音声なし・速度操作なし・スライド 1 枚 4 点以内・イントロ 20 秒以内（T127）
- [ ] Hedera: HashScan verify 済みアドレス 2 件、Blocky402 経由の明示、エージェントの有料リクエスト完了を動画に
- [ ] Privy Financial Flow: HBAR 支払い → 分配 → 復号がライブで 1 回通る
- [ ] Privy B2B: §3 の ❗ を判断し実装 or 開示。上限超過の拒否を動画に
- [ ] 提出フォームで partner prize を 3 枠選択: Hedera「AI & Agentic Payments」/ Privy「Best Financial Flow」/ Privy「Best B2B Financial Product」（The Graph は選ばない）
- [ ] 各パートナーへのフィードバック文（§6）を提出フォームに記入

## 6. スポンサーへのフィードバック下書き（提出フォーム用・英文）

提出要件「各パートナーツールをどう統合したか説明し、フィードバックを提供する」に対応。実装中に
実際に踏んだ点だけを書く（推測で埋めない）。ライブ検証後に追記する箇所は `<…>`。

Hedera / Blocky402:

```
Integrating x402 on Hedera through Blocky402 was straightforward on the HTTP side (/supported, /verify, /settle). Two things cost us time: (1) the `exact` scheme on hedera:testnet only carries plain HBAR transfers, so a value-attached ContractCall (our atomic settleAndIssue) cannot be settled by the facilitator - we had to add a custodial rail and disclose the non-atomic window; a documented path for contract-call settlement would remove that. (2) Hedera is not supported by Subgraph Studio, so indexing means running your own Graph Node; a hosted indexer option for Testnet would lower the barrier for hackathon teams. <add live-run findings>
```

Privy:

```
The embedded wallet and the server wallet APIs were easy to wire (eth_signTypedData_v4 for EIP-712 challenges, secp256k1_sign for the Hedera transaction digest). The gap we hit: Privy policies cannot evaluate a raw-hash signature because it carries no transaction structure, so for a non-EVM-native chain like Hedera the spend limit had to live in our gateway. A policy primitive for raw-hash signing (e.g. per-wallet signing budget or an authorization-key requirement scoped to a session) would let the control stay inside Privy. <add findings from the live login / server-wallet activation>
```

## 7. 見送り（再確認済み・変更なし）

The Graph（Hedera が Subgraph Studio / The Graph Market 非対応で「local-only 不可」要件を満たせない）、
Hedera「Tokenization of Anything」、Bazantic、Arc、World、Chainlink、Ledger、ENS、1inch、Uniswap。
理由の正本は `.claude/skills/ethglobal-strategist/references/truecollective-prize-fit.md` と憲章
「ハッカソン納品ワークフロー」。
