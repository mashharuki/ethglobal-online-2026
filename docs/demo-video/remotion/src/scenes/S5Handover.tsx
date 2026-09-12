import type React from "react";
import { MainTelop } from "../components/MainTelop";
import { RightsGraph } from "../components/RightsGraph";
import { SafeArea } from "../components/SafeArea";

/**
 * 20–24秒。最初の疑問への答えを一枚で。Licenseeの接続は維持、管理者の接続が完成する。
 * これ以降は新しい機能を出さない。
 * 台本テロップ: Keep access connected.／Pass on rights and revenue.
 */
export const S5Handover: React.FC = () => {
  return (
    <SafeArea>
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 20,
        }}
      >
        <MainTelop
          appearAt={6}
          size={84}
          lines={[
            { text: "Keep access connected." },
            { text: "Pass on rights and revenue.", accent: true },
          ]}
        />
        <div style={{ flex: 1, width: "100%", maxWidth: 1120, minHeight: 0 }}>
          <RightsGraph adminEdge="done" focus="buyer" />
        </div>
      </div>
    </SafeArea>
  );
};
