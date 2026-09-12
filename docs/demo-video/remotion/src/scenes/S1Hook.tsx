import type React from "react";
import { Easing, Interactive, interpolate, useCurrentFrame } from "remotion";
import { MainTelop } from "../components/MainTelop";
import { RightsGraph } from "../components/RightsGraph";
import { SafeArea } from "../components/SafeArea";
import { FONT_FAMILY } from "../font";
import { COLORS, TYPE } from "../theme";

/**
 * 0–7秒 問題提起。少し緊張感のある間。注目対象は「Licenseeの利用権」。
 * ナレーション: 企業に貸し出した、ブランドの商材。管理する会社が変わるたびに、
 * "誰が使えて、料金は誰に入るのか"を毎回手作業で整理し直しています。
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
          name="Audience eyebrow"
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
          For character and brand IP managers
        </Interactive.Div>

        <MainTelop
          appearAt={8}
          size={78}
          lines={[
            { text: "Every change of management means" },
            { text: "sorting rights and revenue by hand", accent: true },
          ]}
        />

        <div style={{ flex: 1, width: "100%", maxWidth: 1120, minHeight: 0 }}>
          <RightsGraph adminEdge="switching" focus="buyer" />
        </div>
      </div>
    </SafeArea>
  );
};
