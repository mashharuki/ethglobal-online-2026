import { z } from "zod";

/**
 * Opening のプロップ。素材（本人ナレーション・実アプリ収録）が届いたら Studio 上で差し替える。
 * すべて未指定（既定値）の状態では、字幕＋説明図＋「実アプリ収録待ち」枠だけで再生される
 * （偽の成功画面は出さない）。
 */
export const openingSchema = z.object({
  /** public/audio/narration.m4a を配置したら true。本人収録のみ使用（AI音声・速度変更は禁止）。 */
  hasNarrationAudio: z.boolean(),
  /** public/audio/bgm.m4a を配置したら true。声を邪魔しない音量で下げる。 */
  hasBgm: z.boolean(),
  /** 5–9秒: 実アプリのマーケット（素材カード / x402で購入 / survives-transfer）。画像 or 動画。 */
  coupleClip: z.string(),
  /** 9–15秒 左: 所有者パスの無料アクセス拒否の実アプリ画面（監査ログ deny NOT_CURRENT_OWNER 等）。 */
  contrastDenyClip: z.string(),
  /** 9–15秒 右: 購入した利用権での復号継続の実アプリ画面（Viewer licensee path・use #1 of 5）。 */
  contrastOkClip: z.string(),
  /** 15–20秒: 実決済の配分記録（Dashboard の Revenue allocations: owner + creator）。 */
  revenueClip: z.string(),
  /** 24–30秒: 締め後につなぐ「次の実演画面」の実素材（butt-join 用）。任意。 */
  nextDemoClip: z.string(),
});

export type OpeningProps = z.infer<typeof openingSchema>;

/**
 * 既定は docs/img/ から切り出した実アプリのスクショ（public/footage/*.png）。
 * 実収録が未提供の枠は空文字にして「素材待ち」表示に戻せる。
 */
export const openingDefaults: OpeningProps = {
  hasNarrationAudio: false,
  hasBgm: false,
  coupleClip: "footage/market.png",
  contrastDenyClip: "footage/audit-deny.png",
  contrastOkClip: "footage/viewer-licensee.png",
  revenueClip: "footage/dashboard-revenue.png",
  nextDemoClip: "",
};
