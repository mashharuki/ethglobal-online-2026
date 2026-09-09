import type React from "react";
import { Interactive } from "remotion";
import { FootagePlaceholder } from "../components/FootagePlaceholder";
import { SafeArea } from "../components/SafeArea";
import { FONT_FAMILY } from "../font";
import { COLORS } from "../theme";

/**
 * 9–15秒。中心メッセージ: 所有者パスの無料アクセス拒否 と 購入者の有効な利用権による継続アクセスの対比。
 * 実アプリのスクショを左右2画面で比較する。ラベル・状態表示は画面の外（上のバー）に出し、
 * スクショ本体と字幕のどちらとも重ねない。
 *
 * 実素材:
 * - 左 docs/img/3.jpg → footage/audit-deny.png（Gateway audit log の deny NOT_CURRENT_OWNER）
 * - 右 docs/img/0.jpg → footage/viewer-licensee.png（Viewer licensee path・use #1 of 5・SURVIVE_TRANSFER）
 */
export const S3Contrast: React.FC<{ denyClip: string; okClip: string }> = ({
  denyClip,
  okClip,
}) => {
  return (
    <SafeArea>
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <Interactive.Div
          name="対比テロップ"
          style={{
            fontFamily: FONT_FAMILY,
            fontSize: 42,
            fontWeight: 900,
            lineHeight: 1.3,
            color: COLORS.textHeading,
            textAlign: "center",
          }}
        >
          <span style={{ color: COLORS.deny }}>旧管理者：無料アクセス終了</span>
          {"　／　"}
          <span style={{ color: COLORS.ok }}>購入企業：利用を継続</span>
        </Interactive.Div>

        <div
          style={{
            fontFamily: FONT_FAMILY,
            fontSize: 21,
            color: COLORS.text,
            textAlign: "center",
            border: `1px solid ${COLORS.ok}`,
            borderRadius: 10,
            padding: "7px 16px",
            background: "rgba(107,207,154,0.08)",
          }}
        >
          継続条件: 移転後も存続するプラン（SURVIVE_TRANSFER）／ 期限・残回数の範囲内に限る
        </div>

        <div
          style={{
            flex: 1,
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 30,
            minHeight: 0,
          }}
        >
          <FootagePlaceholder
            src={denyClip || undefined}
            chrome="header"
            imageFit="contain"
            paneTitle="所有者パスの無料アクセス拒否"
            note="監査ログ"
            stateWord={{ text: "無料アクセス：拒否", tone: "deny" }}
            caption="所有者でないアカウントの owner_keygate は deny NOT_CURRENT_OWNER。"
            captureSpec={[
              "移転前に購入企業が利用権を取得済みの同一トークン",
              "移転後、旧所有者が無料アクセスを再試行 → 403 で拒否",
              "取得済みファイルが消える演出はしない",
            ]}
          />
          <FootagePlaceholder
            src={okClip || undefined}
            chrome="header"
            imageFit="contain"
            paneTitle="購入した利用権での復号継続"
            note="Viewer"
            stateWord={{ text: "利用権：継続", tone: "ok" }}
            caption="購入済みの利用権で復号（use #1 of 5）。ライセンスは SURVIVE_TRANSFER。"
            captureSpec={[
              "同一トークン・移転をまたいで再アクセス",
              "移転前に購入した利用権で復号",
              "期限・残回数の範囲内であること",
            ]}
          />
        </div>
      </div>
    </SafeArea>
  );
};
