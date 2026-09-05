# Spec Kit 成果物は日本語で書く

このリポジトリの Spec Kit（SDD）ワークフローが生成・更新するドキュメントは、**本文をすべて日本語で記述する**。チームの共通言語が日本語であり、レビュー速度と認識ずれ防止を優先する。

## 対象（日本語で書く）

`/speckit-*` コマンドおよび `.specify/workflows/` のワークフローが作成・編集する成果物すべて：

- `.specify/memory/constitution.md`（プロジェクト憲章）
- `specs/NNN-<slug>/spec.md`（仕様）
- `specs/NNN-<slug>/plan.md` / `research.md` / `data-model.md` / `quickstart.md`
- `specs/NNN-<slug>/contracts/` 内の説明文・ドキュメント
- `specs/NNN-<slug>/tasks.md`（タスク一覧）
- `specs/NNN-<slug>/checklists/*.md`（チェックリスト）
- `/speckit-analyze`・`/speckit-converge` のレポート出力
- `/speckit-clarify` の質問文、および各コマンドがユーザーへ返す要約・確認メッセージ

## 例外（原文のまま／英語のまま）

翻訳するとかえって曖昧になる・壊れるものは変えない：

- **コード識別子・型名・フィールド名**：`chainId`, `resourceHash`, `policyHash`, `ownerEpoch`, `transferMode` など
- **エラーコード**：`RECEIPT_ALREADY_CONSUMED`, `POLICY_HASH_MISMATCH` など（`docs/idea.md` §10.1 で公開契約として固定済み）
- **標準・プロトコル名・製品名**：ERC-721, EIP-712, x402, The Graph, Hedera, Privy, USDC, IPFS
- **feature ディレクトリの slug / ブランチ名**：`create-new-feature.sh` の制約により ASCII の kebab-case 英語（例：`001-rights-nft-core`）。中身の `spec.md` は日本語
- **Git コミットメッセージ**：`git-workflow.md` に従い Conventional Commits（英語）
- **ソースコード・設定ファイル・コード内コメント**：`code-style.md` に従う
- **外部からの引用・URL・参考リンク**：原文のまま
- 定着した専門用語は、初出で `Rights Receipt（権利レシート）` のように併記し、以降はどちらかに統一してよい

## 運用

- 既存の英語成果物を編集する機会があれば、その変更のついでに**日本語へ書き換える**
- Spec Kit テンプレート（`.specify/templates/*.md`）は上流管理のため英語のままでよい。生成結果を日本語にする
- 憲章の言語も本ルールの対象。改訂（version bump）時に未翻訳部分があれば日本語化する
