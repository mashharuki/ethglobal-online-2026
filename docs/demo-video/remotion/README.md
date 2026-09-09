# TrueCollective — 30秒オープニング（Remotion）

制作仕様: [`../opening-30s-ja.md`](../opening-30s-ja.md)（この動画の唯一の正）。

- 解像度 **1920×1080 / 30fps / 900フレーム（30秒）**、日本語。
- 実アプリ（`apps/web`）のダークテーマを継承（背景 `#101014` / 見出し `#f7f6fb` / アクセント `#bd9aff` / 継続 `#6bcf9a` / 拒否 `#e57a7a`）。
- ロゴは `apps/web/public/brand/truecollective-logo.png` を継承（ダーク下地では白のリバース表示）。

## 実アプリのスクショを使用中（`docs/img/` から切り出し）

制作仕様の指示（「収録素材が未提供なら素材依存箇所を明示し、完成版として偽の成功画面を生成しない」）に従い、
**偽画面は一切描かず**、`docs/img/*.jpg`（実アプリの実スクリーンショット）から必要箇所を切り出して `public/footage/*.png` に配置し、
既定 props（`src/schema.ts` の `openingDefaults`）で読み込んでいる。切り出しは `npx remotion ffmpeg -i ../../img/N.jpg -vf "crop=W:H:X:Y" public/footage/xxx.png`。

| props キー | 既定ファイル | 元 | 内容 | シーン |
|---|---|---|---|---|
| `coupleClip` | `footage/market.png` | `docs/img/4.jpg` | Market：素材カード / 0.1 ħ / Buy access (x402, HBAR) / survives・invalidated on transfer | 5–9秒 |
| `contrastDenyClip` | `footage/audit-deny.png` | `docs/img/3.jpg` | Gateway audit log：`owner_keygate` は `deny NOT_CURRENT_OWNER`、`consume`・`x402_settle` は `allow` | 9–15秒 |
| `contrastOkClip` | `footage/viewer-licensee.png` | `docs/img/0.jpg` | Viewer licensee path：`use #1 of 5`、`decrypted in the browser`、license は `SURVIVE_TRANSFER` | 9–15秒 |
| `revenueClip` | `footage/dashboard-revenue.png` | `docs/img/2.jpg` | Dashboard：Receipts (SURVIVE) ＋ Revenue allocations（`owner 0.07 ħ · creator 0.03 ħ`, block単位の実記録） | 15–20秒 |
| `nextDemoClip` | （空） | — | 後続デモの1カット目。締めから butt-join。空なら「素材待ち」枠 | 28–30秒 |
| `hasNarrationAudio` | `false` | — | `public/audio/narration.m4a` を置いて `true`。本人録音のみ（AI音声・速度変更は禁止） | 全編 |
| `hasBgm` | `false` | — | `public/audio/bgm.m4a` を置いて `true`（`volume=0.16`） | 全編 |

### スクショ使用にあたっての正確性（台本の「偽の結果を描かない」の順守）

- S3左は **Viewer の拒否画面そのものではなく監査ログ**。表示コードは実物どおり `NOT_CURRENT_OWNER`（＝現所有者でないアカウントの無料アクセスは拒否）。`OWNER_EPOCH_MISMATCH` とは言い換えていない。
- S3で「移転が起きた」ことを断定する画面は無いため、ラベル／キャプションは「所有者でないアカウント」「購入した利用権で継続」という事実の範囲でのみ記述。
- S4の配分イメージ（説明図）は数値なし。数値は S4 下部の **実決済の記録スクショ（0.07 / 0.03 ħ）** のみ。
- 各スクショに常時「実アプリ画面」ラベル＋出所（Market / 監査ログ / Viewer / Dashboard）を表示。

さらに理想的な収録（Viewer 上での移転→旧所有者拒否の一連）が撮れたら、対応する props を差し替えるだけで置き換わる（`captureSpec` に撮影内容を明記済み）。

### 素材の区別ラベル（制作仕様の必須要件）

画面上に常時、種類ラベルを出している:

- **説明図**（紫）— 概念図。`RightsGraph` / 継続条件の帯。
- **配分イメージ**（黄）— 収益配分の概念図。`AllocationDiagram`。
- **実アプリ収録**（緑）— 実画面の差し込み枠。`FootagePlaceholder`（素材が入るまでは「収録待ち」）。

## タイムライン（`src/Opening.tsx` / `src/narration.ts`）

| フレーム | 時間 | シーン | メインテロップ |
|---|---|---|---|
| 0–150 | 0–5秒 | `S1Hook` | 管理者が変わる。／利用は、どうなる？ |
| 150–270 | 5–9秒 | `S2Couple` | NFTの移転に、権限が連動。 |
| 270–450 | 9–15秒 | `S3Contrast` | 旧管理者：無料アクセス終了／購入企業：利用を継続 |
| 450–600 | 15–20秒 | `S4Revenue` | 次の利用料 → Creator ＋ 新管理者 |
| 600–720 | 20–24秒 | `S5Handover` | 利用をつなぐ。／権限と収益を引き継ぐ。 |
| 720–900 | 24–30秒 | `S6Close` | TrueCollective／所有の、その先へ。 |

シーン間は 10フレームのクロスフェード。締め（S6）は 28秒（フレーム 840）から次の実演画面へワイプを開始し、暗転を挟まない。

**30秒に収まるかは本人収録で最終確認する。** `src/narration.ts` の `from` / `durationInFrames` は台本タイムラインに沿った字幕の初期値。
実収録の発話の切れ目に合わせて字幕タイミングを調整し、**音声・実演映像の速度は変えない**。読み切れない場合は台本どおり「そのとき」「これからの」等を削る。

## コマンド

```bash
npm i
npm run dev          # Remotion Studio（プレビュー）
npx remotion still Opening out/hook.png --frame=60     # 静止画点検
npm run lint         # eslint + tsc
npx remotion render Opening out/opening.mp4            # 素材が揃ってから
```

静止画点検の代表フレーム: 冒頭 `--frame=60` / 左右比較 `--frame=360` / 収益 `--frame=520` / 締め `--frame=780`。

> レンダリング時、Noto Sans JP（CJK）のグリフ購読で多数のネットワークリクエストが出る（正常）。

## 制作仕様との対応（台本にない機能・数値・保証は入れていない）

- 継続は `SURVIVE_TRANSFER` かつ 期限・残回数の範囲内に限定（`S3Contrast` の帯）。
- 過去（確定済み）の収益は動かさない、Creator への配分は固定（`AllocationDiagram`）。
- 2者分配のみ（Creator + 所有者）。数値・削減率・導入社数などの未測定の数字は入れていない。
- NFTだけで著作権・契約が移転する表現、取得済み素材を回収できる演出は不使用。
- 即時にトランザクションが確定したように見せない（`S2Couple` に「署名・確定待ちを含む」「早回しはしない」を明記）。
