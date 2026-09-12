import type React from "react";
import { Easing, interpolate, useCurrentFrame } from "remotion";
import { FONT_FAMILY } from "../font";
import { COLORS } from "../theme";
import { SourceTag } from "./SourceTag";

/**
 * 権利グラフ（説明図）。台本の中心構造:
 * - 上段: Previous manager → New manager の接続（移転で切り替わる）
 * - 中央: 一つの素材カード
 * - 下段: Licensee の利用権（移転をまたいで維持される）
 *
 * S1 では上段が「切り替わりかける」、S5 では上段が「完成」する。Licenseeの接続は常に維持。
 * 偽の実画面ではなく概念図なので、必ず SourceTag kind="diagram" を出す。
 */
const Node: React.FC<{
  title: string;
  sub?: string;
  tone?: "neutral" | "accent" | "ok" | "dim";
  dim?: number;
}> = ({ title, sub, tone = "neutral", dim = 1 }) => {
  const color =
    tone === "accent"
      ? COLORS.accent
      : tone === "ok"
        ? COLORS.ok
        : tone === "dim"
          ? COLORS.textDim
          : COLORS.textHeading;
  return (
    <div
      style={{
        opacity: dim,
        minWidth: 260,
        padding: "12px 22px",
        borderRadius: 12,
        border: `1px solid ${tone === "neutral" ? COLORS.border : color}`,
        background: `linear-gradient(155deg, ${COLORS.bg2}, ${COLORS.bg})`,
        fontFamily: FONT_FAMILY,
        textAlign: "center",
      }}
    >
      <div style={{ color, fontSize: 30, fontWeight: 700 }}>{title}</div>
      {sub ? (
        <div style={{ color: COLORS.text, fontSize: 21, marginTop: 4 }}>
          {sub}
        </div>
      ) : null}
    </div>
  );
};

const Connector: React.FC<{ color: string; opacity: number }> = ({
  color,
  opacity,
}) => <div style={{ width: 4, height: 22, background: color, opacity }} />;

export const RightsGraph: React.FC<{
  /** 上段（管理者接続）の状態。 */
  adminEdge: "switching" | "done";
  /** 注目対象。台本「1場面で注目させる対象を一つに絞る」。 */
  focus: "buyer" | "admin";
}> = ({ adminEdge, focus }) => {
  const frame = useCurrentFrame();

  const adminProgress =
    adminEdge === "done"
      ? interpolate(frame, [0, 40], [0.35, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: Easing.bezier(0.16, 1, 0.3, 1),
        })
      : interpolate(frame, [10, 70], [0, 0.5], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });

  const buyerPulse = interpolate(frame % 60, [0, 30, 60], [0.55, 1, 0.55], {
    extrapolateRight: "clamp",
  });
  const buyerFocused = focus === "buyer";

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
      }}
    >
      <div style={{ alignSelf: "flex-start", marginBottom: 12 }}>
        <SourceTag kind="diagram" note="Example use case" />
      </div>

      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 12,
        }}
      >
        {/* 上段: Previous manager → New manager */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 20,
            opacity: buyerFocused ? 0.5 : 1,
          }}
        >
          <Node
            title="Previous manager"
            tone="dim"
            dim={interpolate(adminProgress, [0, 1], [1, 0.45])}
          />
          <div
            style={{
              width: 110,
              height: 4,
              borderRadius: 2,
              background: `linear-gradient(90deg, ${COLORS.textDim} ${(1 - adminProgress) * 100}%, ${COLORS.accent} ${(1 - adminProgress) * 100}%)`,
            }}
          />
          <Node
            title="New manager"
            tone={adminEdge === "done" ? "accent" : "neutral"}
            dim={interpolate(adminProgress, [0, 1], [0.5, 1])}
          />
        </div>

        <Connector
          color={adminEdge === "done" ? COLORS.accent : COLORS.textDim}
          opacity={adminEdge === "done" ? 1 : 0.5}
        />

        {/* 中央: 一つの素材カード */}
        <div
          style={{
            padding: "16px 36px",
            borderRadius: 14,
            border: `1px solid ${COLORS.borderStrong}`,
            background: `linear-gradient(155deg, #241d33, ${COLORS.bg2})`,
            fontFamily: FONT_FAMILY,
            color: COLORS.textHeading,
            fontSize: 30,
            fontWeight: 700,
            textAlign: "center",
            boxShadow: "0 20px 60px rgba(0,0,0,0.4)",
          }}
        >
          Asset (NFT)
          <div
            style={{
              fontSize: 20,
              fontWeight: 400,
              color: COLORS.text,
              marginTop: 3,
            }}
          >
            Character and brand usage rights
          </div>
        </div>

        <Connector
          color={COLORS.ok}
          opacity={buyerFocused ? buyerPulse : 0.8}
        />

        {/* 下段: Licensee（維持される） */}
        <div
          style={{
            opacity: buyerFocused ? 1 : 0.9,
            outline: buyerFocused
              ? `2px solid ${COLORS.ok}`
              : "2px solid transparent",
            outlineOffset: 6,
            borderRadius: 14,
          }}
        >
          <Node
            title="Licensee"
            sub="Purchased license · survives transfer"
            tone="ok"
          />
        </div>
      </div>
    </div>
  );
};
