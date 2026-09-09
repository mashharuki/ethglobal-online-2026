import { FPS } from "./theme";

/**
 * ナレーション（本人収録）。台本 docs/demo-video/opening-30s-ja.md 「ナレーションのみ」。
 *
 * 重要:
 * - 音声は「ユーザー提供の本人ナレーション」を使う。AI音声・速度変更は禁止（ETHOnline 提出規定）。
 * - `SUBTITLE_CUES` の from/durationInFrames は台本タイムラインに沿った字幕タイミングの初期値。
 *   実収録が届いたら、実際の発話の切れ目に合わせて調整する（映像側は速度変更しない）。
 * - 字幕は最大2行に収めるため、長い文は複数キューに分割している（読み上げは1続き）。
 * - `public/audio/narration.m4a` が未提供の間は字幕のみ表示し、無音でプレビューする。
 */

export type NarrationCue = {
  id: string;
  /** 画面に焼き込む字幕テキスト（最大2行）。 */
  text: string;
  from: number;
  durationInFrames: number;
};

const s = (sec: number) => Math.round(sec * FPS);

/** 本人が読む原稿（5文）。字幕はこれを分割したもの。 */
export const FULL_SCRIPT = [
  '企業に貸し出した、ブランドの商材。管理する会社が変わるたびに、"誰が使えて、料金は誰に入るのか"を毎回手作業で整理し直しています。',
  "TrueCollectiveでは NFTをリビルドしこの課題を簡単に終わらせます。",
  "移転が完了したら前の管理者の無料アクセスはそこで終了。企業が買った利用権は、期限まで有効なまま。",
  "次の利用料はクリエイターと新しい管理者へ。すでに払われた分は、動かしません。",
  "所有権と利用権を一体に管理し、TrueCollectiveはNFTの真の価値を再定義します。",
];

/**
 * タイミングは本人ナレーション（public/audio/narration.m4a）を
 * `ffmpeg silencedetect` で解析した無音区間に合わせて同期済み（音声は速度変更しない）。
 * 文の切れ目（秒）: 0.97 / 3.18–3.78 / 8.10–9.40 / 12.04–12.42 / 14.10–15.16 /
 *   18.91–19.56 / 22.42–23.12 / 26.20–27.30 / 31.70。
 */
export const SUBTITLE_CUES: NarrationCue[] = [
  // 文1（問題提起）: 0.97–8.10
  { id: "l1a", text: "企業に貸し出した、ブランドの商材。", from: s(0.9), durationInFrames: s(2.5) },
  { id: "l1b", text: "管理する会社が変わるたびに、", from: s(3.75), durationInFrames: s(1.95) },
  {
    id: "l1c",
    text: '"誰が使えて、料金は誰に入るのか"を\n毎回手作業で整理し直しています。',
    from: s(5.75),
    durationInFrames: s(2.35),
  },
  // 文2: 9.40–14.10（内部の間 12.04–12.42 で切替）
  {
    id: "l2a",
    text: "TrueCollectiveでは NFTをリビルドし",
    from: s(9.4),
    durationInFrames: s(2.6),
  },
  {
    id: "l2b",
    text: "この課題を簡単に終わらせます。",
    from: s(12.4),
    durationInFrames: s(1.7),
  },
  // 文3: 15.16–22.42（内部の間 18.91–19.56 で切替）
  {
    id: "l3a",
    text: "移転が完了したら\n前の管理者の無料アクセスはそこで終了。",
    from: s(15.15),
    durationInFrames: s(3.75),
  },
  {
    id: "l3b",
    text: "企業が買った利用権は、\n期限まで有効なまま。",
    from: s(19.55),
    durationInFrames: s(2.85),
  },
  // 文4: 23.12–26.20（内部の間なし＝1息。字幕だけ2分割）
  {
    id: "l4a",
    text: "次の利用料はクリエイターと\n新しい管理者へ。",
    from: s(23.1),
    durationInFrames: s(1.8),
  },
  {
    id: "l4b",
    text: "すでに払われた分は、動かしません。",
    from: s(24.95),
    durationInFrames: s(1.25),
  },
  // 文5: 27.30–31.70
  {
    id: "l5a",
    text: "所有権と利用権を一体に管理し、",
    from: s(27.3),
    durationInFrames: s(2.05),
  },
  {
    id: "l5b",
    text: "TrueCollectiveは\nNFTの真の価値を再定義します。",
    from: s(29.4),
    durationInFrames: s(2.3),
  },
];

/** 読み方（TTSではなく本人読み用のメモ）。 */
export const READING_NOTES =
  "IP＝アイピー、NFT＝エヌエフティー、Creator＝クリエイター、TrueCollective＝トゥルーコレクティブ";

/** public/audio/narration.m4a を配置したら hasNarrationAudio を true に。 */
export const NARRATION_AUDIO_SRC = "audio/narration.m4a";
