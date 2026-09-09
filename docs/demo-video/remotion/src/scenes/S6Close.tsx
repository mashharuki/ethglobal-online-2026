import type React from "react";
import {
  Easing,
  Interactive,
  interpolate,
  useCurrentFrame,
} from "remotion";
import { BrandLockup } from "../components/BrandLockup";
import { FootagePlaceholder } from "../components/FootagePlaceholder";
import { SafeArea } from "../components/SafeArea";
import { FONT_FAMILY } from "../font";
import { COLORS } from "../theme";

/**
 * 24–30秒。24–28秒: 既存ロゴ + コピー「所有の、その先へ。」。
 * 28秒(local 120)から次の実演画面へ切り替え始める。長い暗転・終了画面は挟まない。
 * 30秒(local 180)でプレゼン担当者へ受け渡し（後続の実演を butt-join できる状態で終わる）。
 */
export const S6Close: React.FC<{ nextDemoClip: string }> = ({ nextDemoClip }) => {
  const frame = useCurrentFrame();

  // 120 frame = 28秒。ここから次の実演画面をワイプで出す。
  const wipe = interpolate(frame, [120, 175], [0, 100], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });
  const brandOpacity = interpolate(frame, [8, 26, 118, 150], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });

  return (
    <SafeArea>
      {/* ブランド + コピー */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 34,
          opacity: brandOpacity,
        }}
      >
        <BrandLockup width={720} />
        <Interactive.Div
          name="締めコピー"
          style={{
            fontFamily: FONT_FAMILY,
            fontSize: 64,
            fontWeight: 700,
            color: COLORS.text,
            letterSpacing: "0.04em",
          }}
        >
          所有の、その先へ。
        </Interactive.Div>
      </div>

      {/* 次の実演画面へのつなぎ（butt-join 用） */}
      {wipe > 0 ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            clipPath: `inset(0 0 0 ${100 - wipe}%)`,
          }}
        >
          <FootagePlaceholder
            src={nextDemoClip || undefined}
            paneTitle="次の実演画面へ（プレゼン担当に受け渡し）"
            note="butt-join 用・暗転を挟まない"
            captureSpec={[
              "後続デモの1カット目（同じダークテーマ）",
              "移転操作 → 旧所有者の拒否 → 購入者の継続 → 配分 の実演へ",
            ]}
          />
        </div>
      ) : null}
    </SafeArea>
  );
};
