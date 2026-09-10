import type React from "react";
import {
  AbsoluteFill,
  Easing,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

/**
 * シーンの前後クロスフェード。台本「動きは『接続の切替』を表すために使う」「最後は
 * 長く暗転しない」。背景は SafeArea 側で敷くため、ここはクロスフェードのみ担当。
 */
export const Scene: React.FC<{
  children: React.ReactNode;
  fadeIn?: number;
  fadeOut?: number;
}> = ({ children, fadeIn = 0, fadeOut = 0 }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();

  const inOpacity =
    fadeIn > 0
      ? interpolate(frame, [0, fadeIn], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: Easing.bezier(0.16, 1, 0.3, 1),
        })
      : 1;

  const outOpacity =
    fadeOut > 0
      ? interpolate(
          frame,
          [durationInFrames - fadeOut, durationInFrames],
          [1, 0],
          {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          },
        )
      : 1;

  return (
    <AbsoluteFill style={{ opacity: Math.min(inOpacity, outOpacity) }}>
      {children}
    </AbsoluteFill>
  );
};
