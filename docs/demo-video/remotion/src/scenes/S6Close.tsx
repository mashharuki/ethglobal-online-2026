import type React from "react";
import { Easing, Interactive, interpolate, useCurrentFrame } from "remotion";
import { BrandLockup } from "../components/BrandLockup";
import { SafeArea } from "../components/SafeArea";
import { FONT_FAMILY } from "../font";
import { COLORS } from "../theme";

/**
 * 27–30秒（3秒）。既存ロゴ + コピー「NFTの、その先へ。」だけ。
 * プレゼンスライドへの「つなぎ（butt-join ワイプ）」は削除済み。
 * 長い暗転・終了画面・再度の自己紹介は挟まない。最後はごく短いフェードで終わる。
 */
export const S6Close: React.FC = () => {
  const frame = useCurrentFrame();

  // 入りだけフェード。最後は暗転せずブランドを保持したまま終わる。
  const opacity = interpolate(frame, [6, 22], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });

  return (
    <SafeArea>
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 34,
          opacity,
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
          NFTの、その先へ。
        </Interactive.Div>
      </div>
    </SafeArea>
  );
};
