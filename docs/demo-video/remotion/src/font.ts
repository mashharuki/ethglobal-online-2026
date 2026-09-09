import { loadFont } from "@remotion/google-fonts/NotoSansJP";

/**
 * 日本語は Noto Sans JP の太めウェイトで（台本「読みやすい太めの書体」）。
 * レンダリングはフォント読み込み完了までブロックされる。
 */
const { fontFamily } = loadFont("normal", {
  weights: ["400", "500", "700", "900"],
  // CJK はグリフのチャンク購読で多数のリクエストになる（レンダリングは正常）。
  ignoreTooManyRequestsWarning: true,
});

export const FONT_FAMILY = `${fontFamily}, "Hiragino Sans", "Yu Gothic", system-ui, sans-serif`;
