/**
 * TrueCollective 30秒オープニングの制作定数。
 *
 * 色は apps/web/src/css/index.css のダークテーマ（"premium marketplace" direction）を継承する。
 * 台本: docs/demo-video/opening-30s-ja.md 「映像制作の指定」。
 */

export const FPS = 30;
export const WIDTH = 1920;
export const HEIGHT = 1080;
export const DURATION_IN_FRAMES = 900; // 30秒 固定尺（台本のタイムライン採用）

/** apps/web のダークテーマ実値。色だけでなく状態の文字も必ず併記すること。 */
export const COLORS = {
  bg: "#101014",
  bg2: "#17161c",
  bgElevated: "#1a191f",
  border: "rgba(255,255,255,0.12)",
  borderStrong: "rgba(255,255,255,0.22)",
  textHeading: "#f7f6fb",
  text: "#a6a1b4",
  textDim: "#6b6377",
  accent: "#bd9aff",
  accentStrong: "#b680ff",
  /** 継続（購入企業の利用が続く） */
  ok: "#6bcf9a",
  /** 拒否（旧管理者の無料アクセス終了） */
  deny: "#e57a7a",
  warn: "#e0b45a",
} as const;

/** 1920幅の安全マージン（720p換算でも文字が切れないよう広めに確保）。 */
export const SAFE = {
  x: 140,
  top: 92,
  /** 字幕帯の予約領域を含む。実画面の状態表示と字幕を重ねないため広めに取る。 */
  bottom: 210,
} as const;

/** 字幕帯の高さ（SAFE.bottom の内側）。 */
export const SUBTITLE_BAND = 150;

/** 動画向け文字サイズ（1920幅基準、video-layout.md の最小値を上回るよう設定）。 */
export const TYPE = {
  telop: 108, // メインテロップ（96–120pxを起点）
  telopSmall: 84,
  subtitle: 44, // 字幕（最大2行・1行は短く分割）
  label: 30, // 区別ラベル（説明図 / 配分イメージ / 実アプリ収録）
  eyebrow: 30,
  body: 40,
  mono: 34,
} as const;

/**
 * 素材の区別ラベル。台本の指示:
 * 「利用シーンの説明図、配分イメージ、実アプリ収録を区別できるラベルを付けてください。」
 */
export const SOURCE_KIND = {
  diagram: { label: "説明図", color: COLORS.accent },
  allocation: { label: "配分イメージ", color: COLORS.warn },
  footage: { label: "実アプリ画面", color: COLORS.ok },
} as const;

export type SourceKind = keyof typeof SOURCE_KIND;

/** シーン境界（フレーム）。台本のタイムラインをそのまま採用。 */
export const SCENES = {
  hook: { from: 0, durationInFrames: 150 }, // 0–5秒
  couple: { from: 150, durationInFrames: 120 }, // 5–9秒
  contrast: { from: 270, durationInFrames: 180 }, // 9–15秒
  revenue: { from: 450, durationInFrames: 150 }, // 15–20秒
  handover: { from: 600, durationInFrames: 120 }, // 20–24秒
  close: { from: 720, durationInFrames: 180 }, // 24–30秒
} as const;
