import type React from "react";
import {
  AbsoluteFill,
  Easing,
  interpolate,
  Sequence,
  useCurrentFrame,
} from "remotion";
import { FONT_FAMILY } from "../font";
import { SUBTITLE_CUES } from "../narration";
import { COLORS, SAFE, SUBTITLE_BAND, TYPE } from "../theme";

/**
 * ナレーション字幕。画面最下部の帯にだけ置き、実画面の重要な状態表示（中央〜上部）と重ねない。
 * 台本「字幕は読みやすさを優先し、実画面の重要な状態表示と重ねない」。
 *
 * グローバルフレーム基準で描画するため、Opening のシーン Sequence の外側に置く。
 */
const Line: React.FC<{ text: string; durationInFrames: number }> = ({
  text,
  durationInFrames,
}) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(
    frame,
    [0, 6, durationInFrames - 6, durationInFrames],
    [0, 1, 1, 0],
    {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.bezier(0.16, 1, 0.3, 1),
    },
  );
  return (
    <AbsoluteFill
      style={{
        justifyContent: "flex-end",
        alignItems: "center",
        paddingLeft: SAFE.x,
        paddingRight: SAFE.x,
        paddingBottom: (SAFE.bottom - SUBTITLE_BAND) / 2 + 18,
      }}
    >
      <div
        style={{
          opacity,
          maxWidth: 1400,
          minHeight: SUBTITLE_BAND - 40,
          display: "flex",
          alignItems: "center",
          textAlign: "center",
          fontFamily: FONT_FAMILY,
          fontSize: TYPE.subtitle,
          fontWeight: 500,
          lineHeight: 1.38,
          color: COLORS.textHeading,
          whiteSpace: "pre-line",
          padding: "14px 34px",
          borderRadius: 16,
          backgroundColor: "rgba(16,16,20,0.66)",
          textShadow: "0 2px 10px rgba(0,0,0,0.55)",
        }}
      >
        {text}
      </div>
    </AbsoluteFill>
  );
};

export const SubtitleTrack: React.FC = () => {
  return (
    <>
      {SUBTITLE_CUES.map((cue) => (
        <Sequence
          key={cue.id}
          name={`Subtitle ${cue.id}`}
          from={cue.from}
          durationInFrames={cue.durationInFrames}
          layout="none"
        >
          <Line text={cue.text} durationInFrames={cue.durationInFrames} />
        </Sequence>
      ))}
    </>
  );
};
