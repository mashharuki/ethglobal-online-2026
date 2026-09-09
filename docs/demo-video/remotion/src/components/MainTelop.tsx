import type React from "react";
import {
  Easing,
  Interactive,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { FONT_FAMILY } from "../font";
import { COLORS, TYPE } from "../theme";

/**
 * メインテロップ（一場面につき注目対象は一つ）。上部寄せで、実画面の状態表示や字幕と分離する。
 * `\n` で改行。強調語は `accent` で色付け。
 */
export const MainTelop: React.FC<{
  lines: { text: string; accent?: boolean }[];
  /** ローカル開始フレーム。 */
  appearAt?: number;
  align?: "center" | "left";
  size?: number;
}> = ({ lines, appearAt = 6, align = "center", size = TYPE.telop }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();

  return (
    <Interactive.Div
      name="メインテロップ"
      style={{
        opacity: interpolate(
          frame,
          [appearAt, appearAt + 14, durationInFrames - 10, durationInFrames],
          [0, 1, 1, 0],
          {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          },
        ),
        translate: interpolate(frame, [appearAt, appearAt + 20], ["0px 14px", "0px 0px"], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: Easing.bezier(0.16, 1, 0.3, 1),
        }),
        fontFamily: FONT_FAMILY,
        fontWeight: 900,
        fontSize: size,
        lineHeight: 1.24,
        letterSpacing: "-0.02em",
        color: COLORS.textHeading,
        textAlign: align,
        textShadow: "0 4px 24px rgba(0,0,0,0.45)",
        maxWidth: 1500,
      }}
    >
      {lines.map((l, i) => (
        <div
          key={`${l.text}-${i}`}
          style={{ color: l.accent ? COLORS.accent : COLORS.textHeading }}
        >
          {l.text}
        </div>
      ))}
    </Interactive.Div>
  );
};
