import type React from "react";
import { Easing, Interactive, interpolate, useCurrentFrame } from "remotion";
import { MainTelop } from "../components/MainTelop";
import { RightsGraph } from "../components/RightsGraph";
import { SafeArea } from "../components/SafeArea";
import { FONT_FAMILY } from "../font";
import { COLORS, TYPE } from "../theme";

/**
 * 0–5秒 フック。少し緊張感のある間。注目対象は「購入企業の利用権」。
 * 台本テロップ: 管理者が変わる。／利用は、どうなる？
 */
export const S1Hook: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <SafeArea>
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 14,
        }}
      >
        <Interactive.Div
          name="宛先エウブロウ"
          style={{
            opacity: interpolate(frame, [0, 16], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
              easing: Easing.bezier(0.16, 1, 0.3, 1),
            }),
            fontFamily: FONT_FAMILY,
            fontSize: TYPE.eyebrow,
            fontWeight: 700,
            letterSpacing: "0.12em",
            color: COLORS.accent,
          }}
        >
          キャラクター・ブランドのIP管理担当者へ
        </Interactive.Div>

        <MainTelop
          appearAt={8}
          size={84}
          lines={[
            { text: "管理者が変わる。" },
            { text: "利用は、どうなる？", accent: true },
          ]}
        />

        <div style={{ flex: 1, width: "100%", maxWidth: 1120, minHeight: 0 }}>
          <RightsGraph adminEdge="switching" focus="buyer" />
        </div>
      </div>
    </SafeArea>
  );
};
