import { FPS } from "./theme";

/**
 * ナレーション（本人収録）。台本 docs/demo-video/opening-30s-ja.md 「ナレーションのみ」。
 *
 * 重要:
 * - 音声は「ユーザー提供の本人ナレーション」を使う。AI音声・速度変更は禁止（ETHOnline 提出規定）。
 * - 下記の from/durationInFrames は台本タイムラインに沿った字幕タイミングの初期値。
 *   実収録が届いたら、実際の発話の切れ目に合わせて調整する（映像側は速度変更しない）。
 * - `public/audio/narration.m4a` が未提供の間は字幕のみ表示し、無音でプレビューする。
 */

export type NarrationLine = {
  id: string;
  /** 画面に焼き込む字幕テキスト（最大2行）。 */
  text: string;
  /** 開始フレーム。 */
  from: number;
  /** 表示フレーム数。 */
  durationInFrames: number;
};

const s = (sec: number) => Math.round(sec * FPS);

export const NARRATION: NarrationLine[] = [
  {
    id: "l1",
    text: "IP管理者が変わる。そのとき、販売済みの利用権は？",
    from: s(0.4),
    durationInFrames: s(4.4),
  },
  {
    id: "l2",
    text: "TrueCollectiveなら、NFTの移転に連動。",
    from: s(5.2),
    durationInFrames: s(3.4),
  },
  {
    id: "l3",
    text: "旧管理者の無料アクセスは終了。\n購入済みの利用権は、条件どおり継続。",
    from: s(9.3),
    durationInFrames: s(5.3),
  },
  {
    id: "l4",
    text: "これからの収益は、Creatorと新管理者へ。",
    from: s(15.3),
    durationInFrames: s(4.2),
  },
  {
    id: "l5",
    text: "利用をつなぎ、権限と収益を引き継ぐ。",
    from: s(20.2),
    durationInFrames: s(3.4),
  },
  {
    id: "l6",
    text: "TrueCollective。NFTの、その先へ。\n実際にお見せします。",
    from: s(24.2),
    durationInFrames: s(5.3),
  },
];

/** 読み方（TTSではなく本人読み用のメモ）: IP=アイピー / NFT=エヌエフティー / Creator=クリエイター。 */
export const READING_NOTES =
  "IP＝アイピー、NFT＝エヌエフティー、Creator＝クリエイター、TrueCollective＝トゥルーコレクティブ";

/** public/audio/narration.m4a を配置したら true にする（またはファイル存在で切替）。 */
export const NARRATION_AUDIO_SRC = "audio/narration.m4a";
