import type React from "react";
import { Audio } from "@remotion/media";
import { AbsoluteFill, Sequence, staticFile } from "remotion";
import { Scene } from "./components/Scene";
import { SubtitleTrack } from "./components/SubtitleTrack";
import { NARRATION_AUDIO_SRC } from "./narration";
import type { OpeningProps } from "./schema";
import { S1Hook } from "./scenes/S1Hook";
import { S2Couple } from "./scenes/S2Couple";
import { S3Contrast } from "./scenes/S3Contrast";
import { S4Revenue } from "./scenes/S4Revenue";
import { S5Handover } from "./scenes/S5Handover";
import { S6Close } from "./scenes/S6Close";

/** クロスフェード長（フレーム）。台本「最後は長く暗転しない」。 */
const XF = 10;

/** シーン境界（グローバルフレーム）。台本タイムラインをそのまま採用。 */
const BOUNDS = [
  { key: "hook", start: 0, end: 150 },
  { key: "couple", start: 150, end: 270 },
  { key: "contrast", start: 270, end: 450 },
  { key: "revenue", start: 450, end: 600 },
  { key: "handover", start: 600, end: 720 },
  { key: "close", start: 720, end: 900 },
] as const;

export const Opening: React.FC<OpeningProps> = ({
  hasNarrationAudio,
  hasBgm,
  coupleClip,
  contrastDenyClip,
  contrastOkClip,
  revenueClip,
  nextDemoClip,
}) => {
  const sceneFor = (key: string) => {
    switch (key) {
      case "hook":
        return <S1Hook />;
      case "couple":
        return <S2Couple clip={coupleClip} />;
      case "contrast":
        return <S3Contrast denyClip={contrastDenyClip} okClip={contrastOkClip} />;
      case "revenue":
        return <S4Revenue revenueClip={revenueClip} />;
      case "handover":
        return <S5Handover />;
      case "close":
        return <S6Close nextDemoClip={nextDemoClip} />;
      default:
        return null;
    }
  };

  return (
    <AbsoluteFill style={{ backgroundColor: "#101014" }}>
      {BOUNDS.map((b, i) => {
        const isFirst = i === 0;
        const isLast = i === BOUNDS.length - 1;
        // 入場シーンだけを XF フレーム早くマウントし、前シーンの退場と同じ窓でクロスさせる。
        const from = b.start - (isFirst ? 0 : XF);
        const end = b.end;
        return (
          <Sequence
            key={b.key}
            name={`シーン ${b.key}`}
            from={from}
            durationInFrames={end - from}
          >
            <Scene fadeIn={isFirst ? 0 : XF} fadeOut={isLast ? 0 : XF}>
              {sceneFor(b.key)}
            </Scene>
          </Sequence>
        );
      })}

      {/* 字幕はグローバルフレーム基準。シーンの上に重ねる（最下部の帯のみ）。 */}
      <SubtitleTrack />

      {hasNarrationAudio ? (
        <Audio name="本人ナレーション" src={staticFile(NARRATION_AUDIO_SRC)} />
      ) : null}
      {hasBgm ? (
        <Audio name="BGM" src={staticFile("audio/bgm.m4a")} volume={0.16} />
      ) : null}
    </AbsoluteFill>
  );
};
