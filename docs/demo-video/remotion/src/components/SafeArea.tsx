import type React from "react";
import { AbsoluteFill } from "remotion";
import { COLORS, SAFE } from "../theme";

/**
 * 全シーン共通の下地。ダークテーマの背景と、720p換算でも文字が切れない安全マージンを敷く。
 * 台本「画面外周には余白を確保」。
 */
export const SafeArea: React.FC<{
  children: React.ReactNode;
  /** デバッグ用: 安全枠を可視化する。 */
  showGuides?: boolean;
}> = ({ children, showGuides = false }) => {
  return (
    <AbsoluteFill
      style={{
        backgroundColor: COLORS.bg,
        backgroundImage:
          "radial-gradient(1100px 620px at 82% -12%, rgba(189,154,255,0.16), transparent 60%)",
      }}
    >
      <AbsoluteFill
        style={{
          paddingLeft: SAFE.x,
          paddingRight: SAFE.x,
          paddingTop: SAFE.top,
          paddingBottom: SAFE.bottom,
        }}
      >
        {children}
      </AbsoluteFill>
      {showGuides ? (
        <AbsoluteFill
          style={{
            borderStyle: "solid",
            borderColor: "rgba(255,80,80,0.5)",
            borderWidth: 2,
            margin: `${SAFE.top}px ${SAFE.x}px ${SAFE.bottom}px`,
          }}
        />
      ) : null}
    </AbsoluteFill>
  );
};
