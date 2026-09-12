import type React from "react";
import { Interactive } from "remotion";
import { FootagePlaceholder } from "../components/FootagePlaceholder";
import { SafeArea } from "../components/SafeArea";
import { FONT_FAMILY } from "../font";
import { COLORS } from "../theme";

/**
 * 9–15秒。中心メッセージ: Owner free access denied と 購入者の有効な利用権による継続アクセスの対比。
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
          name="Access comparison"
          style={{
            fontFamily: FONT_FAMILY,
            fontSize: 42,
            fontWeight: 900,
            lineHeight: 1.3,
            color: COLORS.textHeading,
            textAlign: "center",
          }}
        >
          <span style={{ color: COLORS.deny }}>Previous manager: free access ends</span>
          {"　／　"}
          <span style={{ color: COLORS.ok }}>Licensee: access continues</span>
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
          Continued access: SURVIVE_TRANSFER plans only, within expiry and remaining uses.
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
            paneTitle="Owner free access denied"
            note="Audit log"
            stateWord={{ text: "Free access: denied", tone: "deny" }}
            caption="For a non-owner, owner_keygate returns deny NOT_CURRENT_OWNER."
            captureSpec={[
              "Use the same token, with a license purchased before transfer",
              "After transfer, the previous owner retries free access: denied with 403",
              "Do not imply previously downloaded files disappear",
            ]}
          />
          <FootagePlaceholder
            src={okClip || undefined}
            chrome="header"
            imageFit="contain"
            paneTitle="Decryption continues with a purchased license"
            note="Viewer"
            stateWord={{ text: "License: active", tone: "ok" }}
            caption="Decrypt with a purchased license (use #1 of 5). Policy: SURVIVE_TRANSFER."
            captureSpec={[
              "Access the same token again after transfer",
              "Decrypt using a license purchased before transfer",
              "Stay within expiry and remaining uses",
            ]}
          />
        </div>
      </div>
    </SafeArea>
  );
};
