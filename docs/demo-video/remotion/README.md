# TrueCollective — 30秒オープニング（Remotion）

制作仕様: [`../opening-30s-ja.md`](../opening-30s-ja.md)（この動画の唯一の正）。

- 解像度 **1920×1080 / 30fps / 975フレーム（32.5秒）**、日本語。本人ナレーション `public/audio/narration.m4a`（実測 32.49秒）に尺を合わせた（音声・映像の速度は変えない）。
- 実アプリ（`apps/web`）のダークテーマを継承（背景 `#101014` / 見出し `#f7f6fb` / アクセント `#bd9aff` / 継続 `#6bcf9a` / 拒否 `#e57a7a`）。
- ロゴは `apps/web/public/brand/truecollective-logo.png` を継承（ダーク下地では白のリバース表示）。

## 実アプリのスクショを使用中（`docs/img/` から切り出し）

制作仕様の指示（「収録素材が未提供なら素材依存箇所を明示し、完成版として偽の成功画面を生成しない」）に従い、
**偽画面は一切描かず**、`docs/img/*.jpg`（実アプリの実スクリーンショット）から必要箇所を切り出して `public/footage/*.png` に配置し、
既定 props（`src/schema.ts` の `openingDefaults`）で読み込んでいる。切り出しは `npx remotion ffmpeg -i ../../img/N.jpg -vf "crop=W:H:X:Y" public/footage/xxx.png`。

| props キー | 既定ファイル | 元 | 内容 | シーン |
|---|---|---|---|---|
| `coupleClip` | `footage/market.png` | `docs/img/4.jpg` | Market：素材カード / 0.1 ħ / Buy access (x402, HBAR) / survives・invalidated on transfer | 10–15秒 |
| `contrastDenyClip` | `footage/audit-deny.png` | `docs/img/3.jpg` | Gateway audit log：`owner_keygate` は `deny NOT_CURRENT_OWNER`、`consume`・`x402_settle` は `allow` | 15–21秒 |
| `contrastOkClip` | `footage/viewer-licensee.png` | `docs/img/0.jpg` | Viewer licensee path：`use #1 of 5`、`decrypted in the browser`、license は `SURVIVE_TRANSFER` | 15–21秒 |
| `revenueClip` | `footage/dashboard-revenue.png` | `docs/img/2.jpg` | Dashboard：Receipts (SURVIVE) ＋ Revenue allocations（`owner 0.07 ħ · creator 0.03 ħ`, block単位の実記録） | 21–27秒 |
| `hasNarrationAudio` | `true` | — | `public/audio/narration.m4a`（本人録音・32.49秒）配置済み。録り直したら差し替え（AI音声・速度変更は禁止） | 全編 |
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

| フレーム | 時間 | シーン | メインテロップ | 発話区間 |
|---|---|---|---|---|
| 0–282 | 0–9.4秒 | `S1Hook`（問題提起） | 管理会社が変わるたびに／権限と収益を手作業で整理 | 0.97–8.10 |
| 282–453 | 9.4–15.1秒 | `S2Couple` | 所有権と利用権を、／ひとつのNFTで。 | 9.40–14.10 |
| 453–693 | 15.1–23.1秒 | `S3Contrast` | 旧管理者：無料アクセス終了／購入企業：利用を継続 | 15.16–22.42 |
| 693–819 | 23.1–27.3秒 | `S4Revenue` | 次の利用料 → Creator ＋ 新管理者 | 23.12–26.20 |
| 819–975 | 27.3–32.5秒 | `S6Close` | TrueCollective／NFTの、その先へ。 | 27.30–31.70 |

5段構成（v4）。シーン境界・字幕（`src/narration.ts` の `SUBTITLE_CUES`）は本人ナレーションを `ffmpeg silencedetect` で解析した無音区間に同期済み。旧 `S5Handover` は不使用（ファイルは残置）。シーン間は 10フレームのクロスフェード。締めは暗転せずブランドを保持したまま終わる（末尾 ~0.8秒は無音）。
実収録を録り直したら、同じ手順（`npx remotion ffmpeg -i public/audio/narration.m4a -af silencedetect=noise=-32dB:d=0.35 -f null -`）で無音区間を出し、`SUBTITLE_CUES` と `Opening.tsx` の `BOUNDS`・`theme.ts` の `DURATION_IN_FRAMES` を合わせ直す。

**総尺は本人ナレーション（32.49秒）に合わせて 975フレーム（32.5秒）。** `src/narration.ts` の `SUBTITLE_CUES` は発話の無音区間に同期済み。
録り直したら発話の切れ目に合わせて再調整し、**音声・実演映像の速度は変えない**。`FULL_SCRIPT` が本人の読む5文。

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
