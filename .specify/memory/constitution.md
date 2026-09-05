<!--
Sync Impact Report
==================
バージョン変更: 1.2.0 → 1.3.0
  種別: MINOR（外部制約〔Blocky402 facilitator の対応ネットワーク／資産〕との同期。原則 III
        とセキュリティ節の「決済資産」の記述を訂正。原則の数・順序・ガバナンス構造は不変）

変更点（v1.3.0・2026-09-04）:
  III. コア経路にモックを置かない
       — 「1 トランザクションでの USDC 受領」を「1 トランザクションでの決済資産（対象チェーンの
         ネイティブトークン ＝ Hedera Testnet の HBAR）の受領」に訂正。Hedera「AI & Agentic
         Payments」トラックで必須の Blocky402 facilitator（api.testnet.blocky402.com）が
         hedera:testnet / exact スキームでサポートするのはネイティブトークンであり、HTS の
         USDC（0.0.429274）ではないため（/supported 応答による、research.md R-2 / R-4）
  セキュリティ・脅威モデル要件
       — 「settlement は決済と同一トランザクションで原子的」の記述は不変。決済資産がネイティブ
         トークンである点を明記（USDC 固有の allowance / association 前提を撤回）

制定: 2026-09-02（不変） / 改訂: 2026-09-04

--- 以下は v1.2.0（2026-09-04）の記録 ---
バージョン変更: 1.1.0 → 1.2.0
  種別: MINOR（docs/idea.md v1.6 および /speckit-analyze の指摘対応との同期。原則 III・VI・VII
        とセキュリティ節・納品ワークフローを実質的に拡張。原則の数・順序・ガバナンス構造は不変）

変更点（v1.2.0・2026-09-04）:
  III. コア経路にモックを置かない
       — 「AI Agent による復号後データセットへの分析推論」を「接続先の汎用 MCP クライアント
         （Claude Code / Codex 等）による分析推論」と明確化（idea.md v1.6）
  VI.  最小権限・短命アクセス
       — MCP サーバーが代行する x402 決済ウォレットは、生の秘密鍵を仲介者が保持せず、
         セッション支出上限と呼び出し可能なコントラクト・メソッドの allowlist を持つポリシー
         （Privy server wallet の session signer + policy）で制約する箇条を追加
  VII. 正直な主張とスコープ規律
       — 信頼前提の例示に「owner パスの share_U 残存信頼点」「MCP 公開エンドポイントが保持する
         ポリシー制約付き決済ウォレット」を追加
  セキュリティ・脅威モデル要件
       — MCP 決済ウォレットのポリシー制約（支出上限・メソッド allowlist）を追加
  ハッカソン納品ワークフロー
       — submit 対象スポンサーを Hedera・Privy に確定。The Graph の subgraph は発見・監査に
         用いる load-bearing な技術要素だが、Hedera が Subgraph Studio / The Graph Market に
         非対応のため Graph の賞トラックには submit しない（day1 に再確認）

制定: 2026-09-02（不変） / 改訂: 2026-09-04

--- 以下は v1.1.0（2026-09-02）の記録 ---
バージョン変更: 1.0.1 → 1.1.0
  種別: MINOR（既存原則の実質的拡張・訂正。原則の数・順序・ガバナンス構造は不変）

変更点（docs/idea.md v1.2〜v1.5 との同期。原則 III・V・VI・VII を修正）:
  III. コア経路にモックを置かない
       — 「AIキャラクターの推論呼び出し」（A-2 導入前・保護対象を推論APIとしていた頃の
         記述）を撤回し、「KeyGate による復号鍵材料（share_G）放出判定」「AI Agent に
         よる復号後データセットへの分析推論」「x402 決済の原子的 settlement（1 tx での
         USDC受領→RevenueAllocation→ReceiptIssued）」に置き換え（A-2 v1.2/v1.4、決済
         原子化 v1.5 に整合）
  V.   Request-Bound かつ Single-Use な権利付与
       — Receipt 束縛フィールドに `ownerEpochAtIssue`・`transferMode`・`issuedAt` を追加し、
         `requestHash` を `purchaseRequestHash` に改称。EIP-712 struct hash である
         `receiptHash`（オンチェーン認可の権威）の定義を追加
       — `purchaseRequestHash` の定義を修正：個々のアクセス（復号）呼び出しの内容を
         含めてはならない、と明記。旧文言は逆に body hash を含めるとしており、1 回の
         購入で複数回利用するセッション型 Receipt の設計（A-3）と矛盾していた
  VI.  最小権限・短命アクセス
       — 復号鍵材料の分割管理（仲介者単独では復号不能な構成）を新規箇条として追加
         （A-2 v1.4 の鍵配布方式の構造要件を明文化）
  VII. 正直な主張とスコープ規律
       — 非ゴール列挙に「コントラクトウォレット（Safe/ERC-4337）・ERC-1271 非対応」
         「返金・クレジット再発行経路なし」を追加（v1.5 §3.2・§11.2 と同期）し、
         単一チェーンの内容を「Hedera 一本化」と明示（v1.3 と同期）
       — 信頼前提の例示を「settlement の非原子性」から「KeyGate における Gateway の
         可用性・コントラクトウォレット非対応」へ更新（settlement は v1.5 で原子化
         されたため、非原子性はもはや既定の前提ではない）

セクション:
  セキュリティ・脅威モデル要件
       — 「settlement の非原子性は開示した場合のみ許容」を「settlement は決済と同一
         トランザクションで原子的に確定する」に置き換え、非原子構成は既定の設計では
         なくフォールバックとして明示的に格下げ（v1.5 §6.3・§9.1・§10.3 と同期）

追加/削除された原則・セクション: なし（既存 7 原則・3 セクションの構成を維持）

制定: 2026-09-02（不変） / 改訂: 2026-09-02

v1.1.0 で確認すべきテンプレート・ガイダンス:
  ✅ .specify/templates/plan-template.md — 「Constitution Check」ゲートは原則名を実行時
     参照するため静的な変更は不要
  ⚠ specs/001-rights-runtime-mvp/spec.md — 既に KeyGate・原子的決済等 v1.5 相当の内容を
     実装非依存な表現で反映済みのため、再確認は不要
  ✅ CLAUDE.md / .claude/rules/*.md（speckit-language.md 含む）— 変更を要する記述なし

繰り越し TODO: なし。
-->

# TrueCollective 憲章

TrueCollective（真コレクティブNFT）は、動的デジタル資産のための **transfer-coupled rights
runtime（移転連動型の権利ランタイム）** であり、ETHGlobal ETHOnline 2026（2026-09-04 〜
2026-09-16）に向けて開発する。本憲章は 2〜3 人のチームがプロジェクトを設計・実装・テスト・
提出する際の進め方を規定する。場当たり的な判断や非公式な好みよりも本憲章が優先する。
プロダクトの正典は `docs/idea.md` であり、「作業の進め方」について本憲章とブリーフが食い違う
場合は本憲章が優先する。

## コア原則

### I. Transfer-Coupled Rights First（中心命題への忠実さ）

発明は一文で言い切れる：**Owner Epoch が所有者特権を管理し、Rights Receipt（License Epoch）
が購入者特権を管理する。そして NFT 移転は、アクセス・将来収益・既存ライセンスをそれぞれ
定義済みのルールで更新する。**

- すべての機能・仕様・タスクは、この中心命題まで辿れなければならない（MUST）。命題を前進
  させない作業はハッカソンのスコープ外とする。
- 二つの epoch レイヤーは分離を保たなければならない（MUST）。`ownerEpoch` と `licenseEpoch`
  を統合してはならず（MUST NOT）、`transferMode = SURVIVE_TRANSFER` の Receipt 検証では
  現在の `ownerEpoch` が `ownerEpochAtIssue` と一致することを要求してはならない（MUST NOT）
  ——`ownerEpochAtIssue` は監査用メタデータに過ぎない。
- NFT 移転は次のすべてを生じさせなければならない（MUST）：旧所有者の無料アクセスの即時失効、
  新所有者の無料アクセスの即時有効化、期限内の `SURVIVE_TRANSFER` ライセンスの継続、
  *将来の* 収益の settlement 時点の所有者への付け替え。確定済みの収益を遡及的に変更しては
  ならない（MUST NOT）。

*根拠:* 敵対的検証で、素朴な「暗号化 NFT + x402」案は新規性が弱く 54/100 だった。二層分離が
唯一の防御可能な差別化点であり、これを崩すとプロジェクトは単なる Token Gating に退化する。

### II. 認可の唯一の真実源はオンチェーン状態

- 認可判定（所有権、現在の epoch、鍵材料の放出可否を含む）は、判定時点でスマートコントラクト
  から直接読み取らなければならない（MUST）。Indexer や Subgraph の鮮度に依存してはならない
  （MUST NOT）。
- The Graph／「Rights Graph」は、発見・エージェントの意思決定・監査ダッシュボードのため
  *だけ* に使う。許可／拒否の判定における唯一の情報源としてはならない（MUST NEVER）。
- 所有権は `Transfer` イベント時だけでなく、アクセス時にも再検証しなければならない（MUST）。

*根拠:* Indexer の遅延は実在の攻撃面（`Transfer Stale Session`）である。コントラクトのみが
trustless な権威である。

### III. コア経路にモックを置かない（NON-NEGOTIABLE）

デモのコア経路——`ownerOf`／epoch の読み取り、x402 決済の原子的な settlement（1 トランザク
ションでの決済資産〔対象チェーンのネイティブトークン ＝ Hedera Testnet の HBAR〕の受領 →
`RevenueAllocation` 記録 → `ReceiptIssued` emit）、EIP-712 Rights
Receipt の発行と検証、鍵配布の仲介者（Access Gateway）による復号鍵材料の放出可否判定、AI
Agent（idea.md v1.6：接続先の汎用 MCP クライアント ＝ Claude Code / Codex 等）による復号後
データセットへの分析推論——は、実インフラ（実チェーン／testnet、実 x402 settlement、実 AI API）
に対して動作しなければならない（MUST）。モック・スタブ・ハードコード
された応答は、MVP スコープ外と明示された構成要素（`docs/idea.md` §11.2）に *限り* 許容し、
README に開示しなければならない（MUST）。

*根拠:* 「実装が本物である」は Definition of Done の条件 #4。審査員はコアループを偽装した
デモを低く評価する。

### IV. 敵対的テストを先に書く（NON-NEGOTIABLE）

- `docs/idea.md` §10.1 の攻撃・異常系マトリクスが受け入れテストスイートである。各行は
  (a) 名前が安定したエラーコード（例：`RECEIPT_ALREADY_CONSUMED`, `POLICY_HASH_MISMATCH`）
  と (b) 自動テストを持たなければならない（MUST）。
- 各ガードについて、その失敗系の敵対的テストは、ガード実装より前、または同一の変更内で
  書かなければならない（MUST）——後追いは不可。テストのないガードは未完成とみなす。
- 並行系のケース（例：20 並列の Concurrent Replay）は、逐次シミュレーションではなく実際の
  並列実行でテストしなければならない（MUST）。

*根拠:* 勝てるデモは攻撃が *ライブで失敗する* 様子を見せる。テストを後付けすると、
デモが「対処済み」と示すはずのバグを隠すことになる。

### V. Request-Bound かつ Single-Use な権利付与

- すべての有料権利付与（Rights Receipt）は、少なくとも次の値に暗号的に束縛されなければ
  ならない（MUST）：`chainId`, `verifyingContract`, `nftContract`, `tokenId`, `resourceHash`,
  `policyHash`, `licenseEpoch`, `ownerEpochAtIssue`, `licensee`, `permittedAction`,
  `transferMode`, `maxUses`, `expiresAt`, `purchaseRequestHash`, `paymentId`, `nonce`,
  `issuedAt`。この全フィールドの EIP-712 struct hash を `receiptHash` と呼び、オンチェーン
  での権利認可（鍵材料の購入者パス放出判定）の権威とする。
- `purchaseRequestHash` は HTTP メソッド、canonical path、購入時のプラン選択内容、
  `resourceHash`、`policyHash` を含み、x402 支払いリクエスト発行時に一度だけ計算しなければ
  ならない（MUST）。個々のアクセス（復号）呼び出しの内容をこのハッシュに含めてはならない
  （MUST NOT）——含めると呼び出しごとに値が変わり、1 回の購入で複数回利用するセッション型
  Receipt の設計と原理的に矛盾する。個々の利用は `receiptHash` とサーバ管理の `useIndex`
  （厳密に増加する整数）で区別する。これにより Receipt を別リクエスト・別リソース・
  別ポリシーへ転用できない。
- 消費は原子的でなければならない（MUST）：署名／`purchaseRequestHash`／`licenseEpoch`／
  `expiresAt`／利用回数のチェックと利用回数のインクリメントを一つのトランザクション
  （または原子的なスクリプト）で行う。アクセス用コンテンツ／鍵は settlement 確認 *後*
  にのみ解放する（settle-before-release）。
- データベースは `UNIQUE(receipt_hash, use_index)` と `UNIQUE(payment_id, purchase_request_hash)`
  を強制しなければならない（MUST）。

*根拠:* リプレイ、クロスリソース転用、並行二重利用こそが、本プロトコルが解決を主張する
中心的な脅威である。

### VI. 最小権限・短命アクセス

- 平文コンテンツおよび平文の復号鍵をオンチェーンへ置いてはならない（MUST NEVER）。
- 復号鍵材料は分割して管理しなければならない（MUST）：鍵配布の仲介者（Access Gateway）が
  保持する部分だけでは平文へ復号できない構成とし（MUST NOT be sufficient alone）、残りの
  部分はアクセス主体のウォレット署名からクライアント側で決定的に導出する。仲介者が将来
  侵害されても、仲介者が保持する部分単独では復号に無意味でなければならない（MUST）。
- 有料閲覧者へ恒久的な生鍵を渡してはならない（MUST NEVER）。すべてのアクセスは、
  wallet + tokenId + プラン + 有効期限 + 利用回数にスコープされた短命セッション、または
  signed URL とする。
- MCP サーバーが AI クライアントに代わって実行する x402 決済のウォレットは、生の秘密鍵を
  仲介者（Gateway / MCP サーバー）が保持してはならない（MUST NOT）。サーバーサイド署名
  （Privy server wallet の session signer 等）を用い、1 セッションあたりの支出上限と、
  呼び出し可能なコントラクト・メソッドの allowlist を持つポリシーで制約しなければならない
  （MUST）。公開エンドポイントへ到達できるクライアントでも、ポリシー上限を超える支出は
  できないこと。
- Wallet 署名チャレンジには nonce、有効期限、対象 `chainId` を含めなければならない（MUST）。
- 鍵操作、支払い、失効処理、許可／拒否の判定は監査ログへ記録しなければならない（MUST）。

*根拠:* 生鍵が一度漏れれば、下流のすべての保証が無効になる。仲介者を鍵の一部保持者に
留めることで、単一の侵害点をコンテンツ漏洩に直結させない。

### VII. 正直な主張とスコープ規律

- `docs/idea.md` §3.2 および §11.2 の非ゴールは、ハッカソン期間中は拘束力を持つ。特に：
  ZK は設計のみ、単一チェーン（Hedera 一本化）のみ、収益分配は 2 者（Creator + 現在の
  Owner）、汎用マーケットプレイスなし、ERC-1155 なし、コントラクトウォレット
  （Safe / ERC-4337）所有 NFT への対応なし（ERC-1271 未対応）、返金・クレジット再発行
  経路なし、DRM としての主張なし、法的著作権の移転なし。
- プロジェクトの主張範囲は正確に述べなければならない（MUST）：「TrueCollective は Rights
  Gateway における request-binding・idempotency・settle-before-release・並行制御を実装した」
  ——「x402 を安全にした」とは言わない。
- プロトタイプの制約、信頼前提（例：鍵配布における Gateway の可用性が単一障害点になり
  得ること、owner（無料）パスの `share_U` を Gateway が保持する残存信頼点、MCP 公開
  エンドポイントが保持するポリシー制約付き決済ウォレット、コントラクトウォレット所有者への
  非対応）、ハッカソン開始前の作業（`hedra-sample` を含む）、AI ツールの利用、Git 履歴は、
  提出 README に開示しなければならない（MUST）。

*根拠:* 過大な主張は失格と審査員の信頼喪失への近道である（DoD #7）。

## セキュリティ・脅威モデル要件

- **EIP-712 ドメイン束縛:** すべての typed-data 構造は `chainId` と `verifyingContract` を
  束縛する。別チェーンで再利用された Receipt はドメイン不一致で失敗する。
- **一回限りの支払い証明:** x402 の支払い証明／`paymentId` はちょうど一度だけ受理される。
  異なる body での再利用は `PAYMENT_ID_PAYLOAD_CONFLICT` を返す。
- **原子的な消費:** verify + insert-usage + increment を `SELECT ... FOR UPDATE`（または
  原子的な Lua スクリプト）で囲む。Receipt 消費における素朴な `GET` → `SET` は禁止。
- **settlement は決済と同一トランザクションで原子的に確定する:** x402 決済の受領（決済資産は
  対象チェーンのネイティブトークン ＝ Hedera Testnet の HBAR）、`RevenueAllocation` の記録、
  `ReceiptIssued` の emit は 1 つのトランザクションで原子的に行わなければならない（MUST）。
  決済が確定しなかった場合はトランザクション全体が revert し、支払いは徴収されず Receipt も
  発行されない。この原子性が技術的に成立しない構成へやむを
  得ず変更する場合に *限り*、Settlement → Claimable Balance → Claim の 3 段構成へ切り替え、
  trustless でない前提を README に明記しなければならない（MUST）——これは既定の設計では
  なくフォールバックである。
- **エラーコードは公開契約:** §10.1 のコードはテスト・デモ・監査ダッシュボードが用いる
  安定した識別子である。改名は破壊的変更にあたる。
- **AI 決済ウォレットのポリシー制約:** MCP サーバーが AI クライアントに代わって行う x402
  決済は、セッション支出上限と呼び出し可能なコントラクト・メソッドの allowlist を持つ
  ポリシー（Privy server wallet）で制約する。公開 MCP エンドポイントへの到達だけで
  ポリシー上限を超える支出はできない。生の秘密鍵は仲介者が保持しない。
- **ストレージ:** 暗号化コンテンツストアは、公開状態では暗号文のみを露出しなければならない。

## ハッカソン納品ワークフロー

- **スポンサー統合は load-bearing であること。** 統合する各スポンサー技術は、単一の
  デモフローに真に必要でなければならない（MUST）。賞の要件を満たすためだけの後付け統合は
  却下する（DoD #6）。load-bearing でない統合は外す。
  - **submit 対象は Hedera と Privy を軸とする。** Hedera はコア実行基盤（コントラクト
    デプロイ・x402 ゲート付きサービスのホスト）、Privy は所有者・AI クライアントのウォレット
    および MCP 決済ウォレットのポリシー basis。提出時に選ぶ partner prize は最大 3 枠で、
    Hedera「AI & Agentic Payments on Hedera」＋ Privy の 2 トラック（Best Financial Flow /
    Best B2B Financial Product）を基本線とする。
  - **The Graph の subgraph（Rights Graph）は発見・監査に用いる load-bearing な技術要素だが、
    Hedera が Subgraph Studio / The Graph Market に非対応で自前 graph node 運用となるため、
    The Graph の賞トラックには submit しない**（要件「Consume live data from a Graph provider」
    「local-only は不可」を満たせない）。day1 に Subgraph Studio の Hedera 対応状況を再確認し、
    対応済みであれば submit 対象を再検討する。
- **3 分デモ台本（`docs/idea.md` §13.2）が納品契約である。** ハッピーパスの拡張よりも、
  権利状態の *変化*（移転 → 失効 → 新所有者アクセス → エージェント購入 → 攻撃拒否）を
  見せることを優先する。
- **該当 feature の `/speckit-plan` 前にブロッキング判断を解決する。** `docs/idea.md` §21 の
  未決定事項のうち本原則に関わるもの——コアチェーン選定、Rights Receipt をオンチェーンに
  するか否か、購入済みライセンスの移転後の挙動——は、それに依存する feature を計画する前に
  解決し記録しなければならない（MUST）（feature の `plan.md` または ADR に）。本プロジェクト
  では上記 3 点を含む主要項目は `docs/idea.md` v1.3〜v1.5 で解決済みであり、新たな
  blocking 判断が生じた場合にこの手順を適用する。
- **Definition of Done** は `docs/idea.md` §20 の 7 項目リストである。feature または提出物は、
  該当する項目を満たすまで完了とみなさない。
- **事前作業の開示。** イベント開始（2026-09-04）より前に行った作業は README に列挙しな
  ければならない（MUST）。実装コミットは ETHGlobal ルールに従い開始後に行う。

## ガバナンス

- **権威。** 本憲章は非公式な慣行に優先する。`CLAUDE.md` と `.claude/rules/*.md` は実行時の
  開発ガイダンスを提供し、本憲章と整合を保たなければならない（MUST）。矛盾時は本憲章が
  優先し、ルールファイル側を修正する。
- **改訂。** 本ファイルへの変更は必ず（MUST）：(1) 下記ポリシーに従いバージョンを更新し、
  (2) Sync Impact Report コメントと `Last Amended` 日付を更新し、(3) アクティブな貢献者の
  合意を得る（2〜3 人チームでは、現在リポジトリで作業している全員の合意）。いかなる改訂も
  確定済みの収益・発行済みの Receipt に遡及しない。
- **バージョニングポリシー（セマンティック）:**
  - MAJOR — 原則の削除、または後方非互換な再定義。あるいはガバナンス規則の実質的変更。
  - MINOR — 新しい原則・セクションの追加、または既存ガイダンスの実質的な拡張。
  - PATCH — 明確化、字句修正、非意味的な調整（言語の変更のみを含む）。
- **コンプライアンスレビュー。** すべての `/speckit-specify`、`/speckit-plan`、
  `/speckit-tasks`、およびコードレビューは本原則に照らして確認しなければならない（MUST）。
  `/speckit-plan` の「Constitution Check」ゲートが強制点である。逸脱はそのプランの
  Complexity Tracking セクションに記録・正当化しなければならず、さもなければプランは却下する。
- **未解決の逸脱はマージをブロックする。** NON-NEGOTIABLE 原則（III または IV）に違反する
  コードは、締切のプレッシャーがあってもマージしてはならない（MUST NOT）——代わりに
  スコープを削る。

**Version**: 1.3.0 | **Ratified**: 2026-09-02 | **Last Amended**: 2026-09-04
