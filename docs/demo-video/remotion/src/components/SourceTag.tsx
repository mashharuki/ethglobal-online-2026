import type React from "react";
import { FONT_FAMILY } from "../font";
import { SOURCE_KIND, type SourceKind, TYPE } from "../theme";

/**
 * 素材の種類を区別するラベル。台本の必須指示:
 * 「利用シーンの説明図、配分イメージ、実アプリ収録を区別できるラベルを付けてください。」
 *
 * 各パネルの左上に常時表示し、視聴者が「これは説明図であって実画面ではない」と判別できるようにする。
 */
export const SourceTag: React.FC<{
  kind: SourceKind;
  /** 補足（例: "移転確認後"）。 */
  note?: string;
}> = ({ kind, note }) => {
  const { label, color } = SOURCE_KIND[kind];
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 12,
        padding: "8px 16px",
        borderRadius: 999,
        border: `1px solid ${color}`,
        backgroundColor: "rgba(16,16,20,0.72)",
        color,
        fontFamily: FONT_FAMILY,
        fontSize: TYPE.label,
        fontWeight: 700,
        letterSpacing: "0.02em",
        lineHeight: 1,
        whiteSpace: "nowrap",
        maxWidth: "100%",
      }}
    >
      <span
        style={{
          width: 12,
          height: 12,
          borderRadius: 3,
          backgroundColor: color,
        }}
      />
      {label}
      {note ? (
        <span style={{ color: "#f7f6fb", fontWeight: 500 }}>· {note}</span>
      ) : null}
    </div>
  );
};
