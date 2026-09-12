import type React from "react";
import { BrandLockup } from "../components/BrandLockup";
import { FootagePlaceholder } from "../components/FootagePlaceholder";
import { MainTelop } from "../components/MainTelop";
import { SafeArea } from "../components/SafeArea";

/**
 * 7–12秒。落ち着いて解決を提示。注目対象は「実アプリのマーケット（素材カード）」。
 * ナレーション: TrueCollectiveでは NFTをリビルドしこの課題を簡単に終わらせます。
 * （映像側は S2 のキャプションで「署名・確定待ちを含む」を残し、即時完了に見せない）
 * 実素材: docs/img/4.jpg → public/footage/market.png（survives / invalidated on transfer が見える）。
 */
export const S2Couple: React.FC<{ clip: string }> = ({ clip }) => {
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
          size={80}
          lines={[
            { text: "Ownership and usage rights." },
            { text: "One NFT.", accent: true },
          ]}
        />

        <div
          style={{
            flex: 1,
            width: "100%",
            maxWidth: 980,
            minHeight: 0,
            position: "relative",
          }}
        >
          <FootagePlaceholder
            src={clip || undefined}
            chrome="header"
            imageFit="contain"
            paneTitle="Live app / Market (asset cards)"
            note="Market"
            caption="Assets are RightsNFTs. Each asset sets whether licenses survive or are invalidated on transfer. Buy via x402 in HBAR."
            captureSpec={[
              "Open the actual Viewer from an asset card",
              "Use Transfer NFT, including signing and confirmation time",
              "Show the Viewer after transfer confirmation (accessEpoch updated)",
            ]}
          />
          <div
            style={{ position: "absolute", right: 22, top: 20, opacity: 0.82 }}
          >
            <BrandLockup width={168} />
          </div>
        </div>
      </div>
    </SafeArea>
  );
};
