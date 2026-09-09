import type React from "react";
import { Img, Interactive, staticFile } from "remotion";
import { AllocationDiagram } from "../components/AllocationDiagram";
import { SafeArea } from "../components/SafeArea";
import { SourceTag } from "../components/SourceTag";
import { FONT_FAMILY } from "../font";
import { COLORS } from "../theme";

/**
 * 15–20秒。実画面の対比は「継続中」であることをリボンで残しつつ、下部に配分イメージ（説明図）と
 * 実決済の記録（実アプリ画面）を表示。Creator は固定、所有者側だけ 旧→新。過去は動かさない。
 * 実素材: docs/img/2.jpg → footage/dashboard-revenue.png（Revenue allocations: owner + creator, block単位）。
 * 台本テロップ: 次の利用料 → Creator ＋ 新管理者
 */
const Pill: React.FC<{ text: string; tone: "ok" | "deny" }> = ({ text, tone }) => (
  <div
    style={{
      padding: "6px 14px",
      borderRadius: 999,
      border: `1px solid ${tone === "ok" ? COLORS.ok : COLORS.deny}`,
      color: tone === "ok" ? COLORS.ok : COLORS.deny,
      background: "rgba(16,16,20,0.5)",
      fontFamily: FONT_FAMILY,
      fontSize: 21,
      fontWeight: 700,
    }}
  >
    {text}
  </div>
);

export const S4Revenue: React.FC<{ revenueClip: string }> = ({ revenueClip }) => {
  return (
    <SafeArea>
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        <Interactive.Div
          name="収益テロップ"
          style={{
            fontFamily: FONT_FAMILY,
            fontSize: 52,
            fontWeight: 900,
            color: COLORS.textHeading,
            textAlign: "center",
          }}
        >
          次の利用料 → <span style={{ color: COLORS.ok }}>Creator</span> ＋{" "}
          <span style={{ color: COLORS.accent }}>新管理者</span>
        </Interactive.Div>

        {/* S3 の対比は継続中というリボン（実画面の比較を残したまま） */}
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            gap: 12,
            alignItems: "center",
          }}
        >
          <span
            style={{
              fontFamily: FONT_FAMILY,
              fontSize: 19,
              color: COLORS.textDim,
            }}
          >
            対比は継続中
          </span>
          <Pill text="旧管理者：無料アクセス終了" tone="deny" />
          <Pill text="購入企業：利用を継続" tone="ok" />
        </div>

        {/* 配分イメージ（説明図） */}
        <div
          style={{
            borderRadius: 16,
            border: `1px solid ${COLORS.border}`,
            background: `linear-gradient(155deg, ${COLORS.bg2}, ${COLORS.bg})`,
            height: 262,
          }}
        >
          <AllocationDiagram />
        </div>

        {/* 実決済の記録（実績数値は実決済後の記録のみ使用） */}
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <SourceTag kind="footage" note="Dashboard · 実決済の記録（owner ＋ creator）" />
          <div
            style={{
              flex: 1,
              minHeight: 0,
              borderRadius: 12,
              overflow: "hidden",
              border: `1px solid ${COLORS.border}`,
              background: COLORS.bg2,
            }}
          >
            {revenueClip ? (
              <Img
                src={
                  revenueClip.startsWith("http")
                    ? revenueClip
                    : staticFile(revenueClip)
                }
                style={{ width: "100%", height: "100%", objectFit: "contain" }}
              />
            ) : (
              <div
                style={{
                  padding: "14px 18px",
                  fontFamily: FONT_FAMILY,
                  fontSize: 20,
                  color: COLORS.text,
                }}
              >
                素材待ち: Dashboard の Revenue allocations（owner + creator, block単位の実記録）
              </div>
            )}
          </div>
        </div>
      </div>
    </SafeArea>
  );
};
