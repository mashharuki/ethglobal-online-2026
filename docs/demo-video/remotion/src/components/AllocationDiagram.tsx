import type React from "react";
import { Easing, interpolate, useCurrentFrame } from "remotion";
import { FONT_FAMILY } from "../font";
import { COLORS } from "../theme";
import { SourceTag } from "./SourceTag";

/**
 * 配分イメージ（説明図）。台本 15–20秒:
 * - これからの収益は Creator と 新管理者 へ
 * - Creator は固定、所有者側だけ 旧管理者 → 新管理者
 * - 過去（確定済み）の支払いは動かさない
 *
 * 数値は入れない（台本「台本にない数値・保証を追加しない」「実績数値は実決済後のみ」）。
 * 2者分配のみ（creator + owner）。
 */
const Chip: React.FC<{
  label: string;
  tone: "ok" | "accent" | "dim";
  sub?: string;
}> = ({ label, tone, sub }) => {
  const color =
    tone === "ok"
      ? COLORS.ok
      : tone === "accent"
        ? COLORS.accent
        : COLORS.textDim;
  return (
    <div
      style={{
        padding: "10px 18px",
        borderRadius: 10,
        border: `1px solid ${color}`,
        background: "rgba(16,16,20,0.6)",
        fontFamily: FONT_FAMILY,
        textAlign: "center",
      }}
    >
      <div style={{ color, fontSize: 26, fontWeight: 700 }}>{label}</div>
      {sub ? (
        <div style={{ color: COLORS.text, fontSize: 18, marginTop: 2 }}>
          {sub}
        </div>
      ) : null}
    </div>
  );
};

export const AllocationDiagram: React.FC = () => {
  const frame = useCurrentFrame();

  const ownerSwitch = interpolate(frame, [22, 33], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });
  const flow = interpolate(frame, [6, 30], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        gap: 12,
        padding: "20px 32px 16px",
      }}
    >
      <div>
        <SourceTag kind="allocation" />
      </div>

      {/* 確定済みの収益: 変更なし */}
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <div
          style={{
            fontFamily: FONT_FAMILY,
            color: COLORS.textDim,
            fontSize: 22,
            minWidth: 150,
          }}
        >
          確定済みの収益
        </div>
        <div style={{ display: "flex", gap: 10, opacity: 0.55 }}>
          <Chip label="過去の支払い" tone="dim" sub="変更なし・ロック" />
          <Chip label="過去の支払い" tone="dim" sub="変更なし・ロック" />
        </div>
      </div>

      <div style={{ height: 1, background: COLORS.border }} />

      {/* これからの利用料 */}
      <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
        <div
          style={{
            fontFamily: FONT_FAMILY,
            color: COLORS.textHeading,
            fontSize: 24,
            fontWeight: 700,
            minWidth: 150,
          }}
        >
          次の利用料
        </div>
        <div
          style={{
            width: 60,
            height: 4,
            borderRadius: 2,
            background: COLORS.accent,
            opacity: flow,
          }}
        />
        <div style={{ display: "flex", gap: 12 }}>
          <Chip label="Creator" tone="ok" sub="配分は維持（固定）" />
          <div style={{ position: "relative", minWidth: 210 }}>
            <div
              style={{
                opacity: 1 - ownerSwitch,
                position: "absolute",
                inset: 0,
              }}
            >
              <Chip label="旧管理者" tone="dim" sub="これ以降は対象外" />
            </div>
            <div style={{ opacity: ownerSwitch }}>
              <Chip label="新管理者" tone="accent" sub="所有者側の配分先" />
            </div>
          </div>
        </div>
      </div>

      <div
        style={{ fontFamily: FONT_FAMILY, color: COLORS.text, fontSize: 20 }}
      >
        ※ 変わるのは未確定分の所有者側のみ。Creator
        への配分と確定済みの収益は変わらない。
      </div>
    </div>
  );
};
