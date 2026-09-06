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
| コントラクト verify（`RightsNFT` / `RightsRegistry`） | ✅ | Hedera Testnet（chainId 296）へデプロイ済み・Sourcify で "Exact Match" 検証済み（このプロジェクトの `hardhat.config.ts` は `verify.sourcify` を使用、HashScan 独自の verify 機能ではない）。`packages/shared/src/addresses.ts` の `DEFAULT_DEPLOYMENT` とREADME「Deployed Contract」表に実アドレス記載済み。2026-09-06 に Sourcify の該当ページ（`repo.sourcify.dev/296/<address>`）を直接確認して ✅ にした |
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
| **Privy control を最低 1 つ**（policies / signers / key quorums / intents） | ❗ | **現状の実装は「Privy server wallet が署名者（signer）で、生鍵は gateway に無い」＋「支出上限は gateway 側の per-session cap（`MCP_SESSION_SPEND_CAP_TINYBAR`、`mcp/session.ts`）」**。`wallet.ts` のコメントどおり、Hedera の tx digest を `secp256k1_sign` する raw-hash 署名には Privy の policy が評価できる tx 構造が無く、**Privy 側の policy / key quorum / authorization key は未設定**（`grep -rEi 'authorization|quorum|policy' apps/gateway/src/mcp` で 0 件）。**判断が必要**: (a) 「server wallet が署名者」を Privy control として主張する ― ただし server wallet を持つこと自体は「設定された control」ではなく、要件の「signers」を満たす根拠としては弱い。(b) server wallet に Privy の authorization key（key quorum）を付け、署名 RPC に gateway の authorization signature を必須化する ― raw-hash 署名でも成立する**認可制御**（実装は wallet の `owner` / authorization key 設定＋署名 RPC への authorization signature 付与。工数は小〜中、day1 の R-9 検証と同じ経路）。**推奨は (b)**。注意点 2 つ: ① (b) は「誰が署名を要求できるか」を Privy 側で縛る制御であって、**支出額の強制は gateway の per-session cap のまま**（Privy へ移らない）。文書・動画では両者を分けて説明する。② デモで見せるべきは「authorization signature が無い / 不正な署名要求を **Privy が拒否する**」場面。上限超過の拒否だけでは gateway 側の enforcement しか証明できない。③ (b) を採るなら、raw-hash 署名（`secp256k1_sign`）でも Privy が authorization key を実際に要求することを day1 で実測してから主張する |
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
# 監査対象 commit を固定し（669c4dc = PR #25 merge 時点の main）、--reverse で古い順に走査して
# 各パスの「最初に追加された日」を取る（削除→再追加されたパスでも最古の追加日が残る）。
# %ad は author date（メタデータ。改竄不能な証明ではなく、公開履歴との整合を示す補助資料）。
git log --reverse --diff-filter=A --name-only --format='DATE %ad' --date=short 669c4dcc98d0dd3ec9d2b86f7f8fa7aecea609e2 \
  | awk '/^DATE/{d=$2;next} NF{if(!($0 in s)) s[$0]=d} END{for(f in s) if(s[f]<"2026-09-04") print s[f], f}' \
  | wc -l
# 0  （＝ 2026-09-04 より前に初回追加された tracked ファイルは 0 件）
```

- リポジトリ履歴の初回コミットは 2026-09-05 07:28 JST（イベント開始 09-04 以降）。tracked ファイルで
  09-04 より前に追加されたものは 0 件（上のコマンドで 2026-09-06 に実測）。
- ただし README「Prior work and disclosure」のとおり、これは**コミット時刻の事実**であって著作の
  事実ではない。`hedra-sample` 由来の公開ボイラープレート（Hardhat ERC-721 mint / subgraph example /
  x402 + Privy web sample）はイベント前から存在し TrueCollective 固有ロジックを含まない（From Scratch
  の「公開ライブラリ・スターターキットは可」に該当）。
- ❗ **`specs/` `.specify/` の設計文書は 2026-09-02〜03 に作成**（Spec Kit）。ルール上、AI ポリシーは
  「spec-driven ワークフロー可・spec とプロンプトを同梱」と明記する一方、From Scratch トラックは
  「事前のプロジェクト固有コード・デザイン・アセットは不可」とも書く。**事前の設計文書がどちらに
  当たるかを規定する明文は references に無い**。README / `showcase.md` では「開示した上で判断は主催者に
  委ねる」書き方に統一する（「AI ポリシー上許容」と断定しない）。判断を確実にしたければ、提出前に
  ETHGlobal の Discord / サポートで確認する。
- 提出前に main の履歴が「連続した小さなコミット」であること（単一巨大コミット禁止）を
  `git log --shortstat --format='%ad %h %s' --date=short main` で **コミットごとの変更量と時系列**を見て
  確認する（件数や PR 一覧だけでは粒度は分からない）。

## 5. 提出時チェックリスト（全枠共通・`truecollective-prize-fit.md` と同期）

拘束力のあるルール（締切・動画規定・partner prize 3 枠・AI 開示・事前作業の区別）の原文は
公式ページ https://ethglobal.com/events/ethonline2026 （rules / prizes タブ）で提出直前に再確認する。
references の転記は 2026-09-04 時点。以下の「箇条書き 4 点以内・イントロ 20 秒以内」は
公式の提示スライド指針、「2〜4 分」は動画の必須規定（Hedera 単独の上限は 5 分だが全枠共通で 2〜4 分に合わせる）。

- [ ] 公開 GitHub、コミット履歴が 2026-09-05 から連続（§4 の `--shortstat` で粒度も確認）
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
Integrating x402 on Hedera through Blocky402 was straightforward on the HTTP side (/supported, /verify, /settle). Two things shaped our design: (1) from the @x402/hedera exact-scheme documentation, the scheme carries plain HBAR transfers, so we did not expect the facilitator to settle a value-attached ContractCall (our atomic settleAndIssue) and built a custodial rail with a disclosed non-atomic window as the default; <confirm or correct after the day-1 rail probe: did /settle accept a contract call?>. A documented path for contract-call settlement would let the receipt be anchored in the same transaction as the payment. (2) Hedera is not supported by Subgraph Studio, so indexing means running your own Graph Node; a hosted indexer option for Testnet would lower the barrier for hackathon teams. <add live-run findings>
```

Privy:

```
The embedded wallet and the server wallet APIs were easy to wire (eth_signTypedData_v4 for EIP-712 challenges, secp256k1_sign for the Hedera transaction digest). The gap we hit: for a raw 32-byte digest, a wallet policy has no amount, recipient or method to evaluate, so on a chain whose native transfers are not EVM transactions (Hedera) our per-session spend limit had to live in the gateway rather than in a Privy policy. A primitive that applies to raw-hash signing - a per-wallet signing budget, or an authorization-key requirement that can be scoped to a session - would let that control stay inside Privy. <add findings from the live login / server-wallet activation / authorization-key test>
```

## 7. 見送り（再確認済み・変更なし）

The Graph（Hedera が Subgraph Studio / The Graph Market 非対応で「local-only 不可」要件を満たせない）、
Hedera「Tokenization of Anything」、Bazantic、Arc、World、Chainlink、Ledger、ENS、1inch、Uniswap。
理由の正本は `.claude/skills/ethglobal-strategist/references/truecollective-prize-fit.md` と憲章
「ハッカソン納品ワークフロー」。
