import { Audio } from "@remotion/media";
import type React from "react";
import { AbsoluteFill, Sequence, staticFile } from "remotion";
import { Scene } from "./components/Scene";
import { SubtitleTrack } from "./components/SubtitleTrack";
import { NARRATION_AUDIO_SRC } from "./narration";
import { S1Hook } from "./scenes/S1Hook";
import { S2Couple } from "./scenes/S2Couple";
import { S3Contrast } from "./scenes/S3Contrast";
import { S4Revenue } from "./scenes/S4Revenue";
import { S6Close } from "./scenes/S6Close";
import type { OpeningProps } from "./schema";

/** クロスフェード長（フレーム）。台本「最後は長く暗転しない」。 */
const XF = 10;

/**
 * シーン境界（グローバルフレーム）。本人ナレーション（public/audio/narration.m4a、
 * silencedetect で検出した文の切れ目）に合わせた 5段構成 / v4。総尺 975f（32.5s）。
 *  A 問題提起  0.0–9.4s   （文1: 0.97–8.10）
 *  B 連動      9.4–15.1s  （文2: 9.40–14.10）
 *  C 対比      15.1–23.1s （文3: 15.16–22.42）
 *  D 配分      23.1–27.3s （文4: 23.12–26.20）
 *  E 締め      27.3–32.5s （文5: 27.30–31.70）
 */
const BOUNDS = [
  { key: "problem", start: 0, end: 282 },
  { key: "couple", start: 282, end: 453 },
  { key: "contrast", start: 453, end: 693 },
  { key: "revenue", start: 693, end: 819 },
  { key: "close", start: 819, end: 975 },
] as const;

export const Opening: React.FC<OpeningProps> = ({
  hasNarrationAudio,
  hasBgm,
  coupleClip,
  contrastDenyClip,
  contrastOkClip,
  revenueClip,
}) => {
  const sceneFor = (key: string) => {
    switch (key) {
      case "problem":
        return <S1Hook />;
      case "couple":
        return <S2Couple clip={coupleClip} />;
      case "contrast":
        return (
          <S3Contrast denyClip={contrastDenyClip} okClip={contrastOkClip} />
        );
      case "revenue":
        return <S4Revenue revenueClip={revenueClip} />;
      case "close":
        return <S6Close />;
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
