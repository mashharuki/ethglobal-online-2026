import type { AssetSummary } from "../api/client";
import { short } from "../graph/queries";
import { useAssetMotion } from "../lib/useAssetMotion";
import AssetArt from "./AssetArt";
import PricePanel from "./PricePanel";

/**
 * Market redesign (design review 2026-09): one listing, in the "premium marketplace" direction.
 * Must stay a <section> containing literal "token #{tokenId}" text and keep the "Buy access" /
 * "Access as owner (free)" button labels verbatim - apps/e2e/lib/ui.ts's assetCard() locator and
 * buyerFlow/ownerFlow specs (SC-002, SC-008) match on exactly these.
 */
export default function AssetCard(props: {
  asset: AssetSummary;
  index: number;
  previewHref: string;
  onBuy: () => void;
  buying: boolean;
  buyDisabledReason?: string;
  onAccessAsOwner: () => void;
  isOwner: boolean;
}) {
  const { asset } = props;
  const motionRef = useAssetMotion();
  return (
    <section
      ref={motionRef}
      className="card asset-card"
      style={{ animationDelay: `${Math.min(props.index, 8) * 60}ms` }}
    >
      <div className="asset-art">
        <div className="asset-art-motion">
          <AssetArt assetId={asset.assetId} />
        </div>
        <span className="asset-art-badge">
          {props.isOwner ? "you own this" : "preview available"}
        </span>
      </div>
      <div className="asset-card-body space-y-3">
        <div>
          <h3 className="asset-card-title" title={asset.assetId}>
            asset {short(asset.assetId)}
          </h3>
          {/* apps/e2e/lib/ui.ts's assetCard() locator matches literal "token #<id>" text */}
          <div className="asset-card-meta">
            token #{asset.tokenId} · owner{" "}
            <code title={asset.owner}>{short(asset.owner ?? "?")}</code>
          </div>
        </div>
        <a
          className="btn"
          href={props.previewHref}
          target="_blank"
          rel="noreferrer"
        >
          Preview
        </a>
        <PricePanel
          asset={asset}
          onBuy={props.onBuy}
          buying={props.buying}
          disabledReason={props.buyDisabledReason}
        />
        {props.isOwner && (
          <button type="button" className="btn" onClick={props.onAccessAsOwner}>
            Access as owner (free)
          </button>
        )}
      </div>
    </section>
  );
}
