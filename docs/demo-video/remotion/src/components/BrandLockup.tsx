import type React from "react";
import { Img, staticFile } from "remotion";

/**
 * 既存ロゴ（apps/web/public/brand/truecollective-logo.png）を使用する。
 *
 * オリジナルは白背景・黒ワードマーク。ダーク下地では読めないため、ダーク用途では
 * 反転処理（brightness(0) invert(1)）でモノクロ白のリバースロゴにする。これは
 * 実プロダクトのダークテーマに合わせた標準的なリバース表現で、ロゴの改変ではない。
 */
export const BrandLockup: React.FC<{
  /** ロゴの表示幅(px)。 */
  width: number;
  /** dark: モノクロ白リバース / light: 原版。 */
  variant?: "dark" | "light";
  opacity?: number;
}> = ({ width, variant = "dark", opacity = 1 }) => {
  return (
    <Img
      name="TrueCollective logo"
      src={staticFile("brand/truecollective-logo.png")}
      style={{
        width,
        height: "auto",
        opacity,
        filter:
          variant === "dark"
            ? "brightness(0) invert(1) drop-shadow(0 6px 26px rgba(0,0,0,0.5))"
            : "none",
      }}
    />
  );
};
