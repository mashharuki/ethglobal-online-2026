import { Video } from "@remotion/media";
import type React from "react";
import {
  Easing,
  Img,
  interpolate,
  staticFile,
  useCurrentFrame,
} from "remotion";
import { FONT_FAMILY } from "../font";
import { COLORS } from "../theme";
import { SourceTag } from "./SourceTag";

const IMAGE_RE = /\.(png|jpe?g|webp|avif|gif)$/i;

type StateWord = { text: string; tone: "ok" | "deny" | "neutral" };

const toneOf = (t?: StateWord["tone"]) =>
  t === "ok" ? COLORS.ok : t === "deny" ? COLORS.deny : COLORS.textDim;

/**
 * 実アプリ画面の差し込み枠。実アプリ（apps/web）のスクショ（静止画）でも動画でも受ける。
 *
 * 台本の必須ルール:
 * - 「収録素材が未提供なら素材依存箇所を明示し、完成版として偽の成功画面を生成しないでください。」
 * - src 未指定の間は "素材待ち" 表示と撮影指示だけを出す。成功/拒否のUIは描かない。
 * - src（public/footage/*.png / *.mp4 等）が入ったら実素材に差し替わる。
 *
 * chrome:
 * - "overlay"（既定）: ラベル・状態タグを画面の上に重ねる（素材待ち枠向け）。
 * - "header": ラベル・状態タグを画面の外（上のバー）に出し、スクショ本体を隠さない。
 */
export const FootagePlaceholder: React.FC<{
  src?: string;
  paneTitle: string;
  captureSpec: string[];
  note?: string;
  stateWord?: StateWord;
  imageFit?: "contain" | "cover";
  chrome?: "overlay" | "header";
  /** header 用の短いキャプション（スクショが何を示しているか）。 */
  caption?: string;
}> = ({
  src,
  paneTitle,
  captureSpec,
  note,
  stateWord,
  imageFit = "contain",
  chrome = "overlay",
  caption,
}) => {
  const frame = useCurrentFrame();
  const enter = interpolate(frame, [0, 16], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });

  const resolved = src
    ? src.startsWith("http")
      ? src
      : staticFile(src)
    : undefined;
  const isImage = src ? IMAGE_RE.test(src) : false;

  const media =
    resolved && isImage ? (
      <Img
        src={resolved}
        style={{
          width: "100%",
          height: "100%",
          objectFit: imageFit,
          objectPosition: "center",
        }}
      />
    ) : resolved ? (
      <Video
        src={resolved}
        objectFit="cover"
        style={{ width: "100%", height: "100%" }}
      />
    ) : (
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          gap: 12,
          padding: chrome === "header" ? "22px 34px" : "78px 34px 28px",
          fontFamily: FONT_FAMILY,
          backgroundImage:
            "repeating-linear-gradient(45deg, rgba(255,255,255,0.03) 0 2px, transparent 2px 22px)",
        }}
      >
        <div
          style={{ color: COLORS.textHeading, fontSize: 30, fontWeight: 700 }}
        >
          <span style={{ color: COLORS.accent }}>● 素材待ち</span> — {paneTitle}
        </div>
        <div style={{ color: COLORS.textDim, fontSize: 20, fontWeight: 500 }}>
          撮影すべき内容（偽の結果は描かない）:
        </div>
        <ul
          style={{
            margin: 0,
            paddingLeft: 24,
            color: COLORS.text,
            fontSize: 22,
            lineHeight: 1.5,
            fontWeight: 400,
          }}
        >
          {captureSpec.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>
    );

  if (chrome === "header") {
    return (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          gap: 8,
          opacity: enter,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "nowrap",
          }}
        >
          <SourceTag kind="footage" note={note} />
          {stateWord ? (
            <div
              style={{
                whiteSpace: "nowrap",
                padding: "5px 14px",
                borderRadius: 9,
                border: `1px solid ${toneOf(stateWord.tone)}`,
                backgroundColor: "rgba(16,16,20,0.78)",
                color: toneOf(stateWord.tone),
                fontFamily: FONT_FAMILY,
                fontSize: 24,
                fontWeight: 700,
              }}
            >
              {stateWord.text}
            </div>
          ) : null}
        </div>
        {caption ? (
          <div
            style={{
              fontFamily: FONT_FAMILY,
              fontSize: 19,
              color: COLORS.text,
              lineHeight: 1.35,
            }}
          >
            {caption}
          </div>
        ) : null}
        <div
          style={{
            position: "relative",
            flex: 1,
            minHeight: 0,
            borderRadius: 16,
            overflow: "hidden",
            border: `1px solid ${COLORS.border}`,
            background: `linear-gradient(155deg, ${COLORS.bg2}, ${COLORS.bg})`,
          }}
        >
          {media}
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        borderRadius: 18,
        overflow: "hidden",
        border: `1px solid ${COLORS.border}`,
        background: `linear-gradient(155deg, ${COLORS.bg2}, ${COLORS.bg})`,
        opacity: enter,
      }}
    >
      {media}
      <div style={{ position: "absolute", left: 18, top: 18 }}>
        <SourceTag kind="footage" note={note} />
      </div>
      {stateWord ? (
        <div
          style={{
            position: "absolute",
            right: 18,
            top: 18,
            padding: "8px 16px",
            borderRadius: 10,
            border: `1px solid ${toneOf(stateWord.tone)}`,
            backgroundColor: "rgba(16,16,20,0.78)",
            color: toneOf(stateWord.tone),
            fontFamily: FONT_FAMILY,
            fontSize: 28,
            fontWeight: 700,
          }}
        >
          {stateWord.text}
        </div>
      ) : null}
    </div>
  );
};
