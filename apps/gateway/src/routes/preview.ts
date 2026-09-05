import { parseManifest } from "@truenft/shared";
import type { Hono } from "hono";
import type { Hex } from "viem";
import {
  cachedGraphQuery,
  type GraphToken,
  LIST_TOKENS_QUERY,
} from "../graph/cache";
import { AssetNotFoundError, manifestHttpUrl } from "../manifest/resolver";
import { type AppEnv, notFound, parseAssetId } from "./schemas";

/**
 * Discovery routes (tasks.md T086, FR-019 / FR-020). Nothing here authorizes anything:
 * the list comes from the subgraph (+ cache) and manifests are expanded as published.
 */
type AssetSummary = {
  assetId: Hex;
  tokenId: string;
  nftContract: Hex;
  owner?: Hex;
  creator?: Hex;
  previewURI: string;
  manifestURI: string;
  paidAccess: { price: string; durationSec: number; maxUses: number };
  transferMode: "SURVIVE_TRANSFER" | "INVALIDATE_ON_TRANSFER";
  permissions: {
    commercialUse: boolean;
    aiTraining: boolean;
    derivativeGeneration: boolean;
  };
  accessEpoch?: number;
  licenseEpoch?: number;
};

export function registerPreviewRoutes(app: Hono<AppEnv>): void {
  app.get("/assets", async (c) => {
    const services = c.get("services");
    const result = await cachedGraphQuery<{ rightsTokens: GraphToken[] }>(
      services.db,
      services.graph,
      "assets:list",
      LIST_TOKENS_QUERY,
      { first: 100 },
      { now: services.now },
    );
    const tokens = result.data?.rightsTokens ?? [];
    const summaries: AssetSummary[] = [];
    for (const token of tokens) {
      if (token.manifestURI === "") continue;
      let manifestJson: unknown;
      try {
        manifestJson = await services.fetchManifest(token.manifestURI);
      } catch {
        continue; // unreachable manifest: not discoverable right now
      }
      const parsed = parseManifest(manifestJson);
      if (!parsed.ok) continue;
      const m = parsed.data;
      summaries.push({
        assetId: m.assetId as Hex,
        tokenId: m.tokenId,
        nftContract: m.nftContract as Hex,
        owner: token.owner.id as Hex,
        creator: token.creator as Hex,
        previewURI: m.previewURI,
        manifestURI: token.manifestURI,
        paidAccess: m.paidAccess,
        transferMode: m.transferMode,
        permissions: m.permissions,
        accessEpoch: Number(token.accessEpoch),
        licenseEpoch: Number(token.licenseEpoch),
      });
    }
    return c.json(summaries);
  });

  app.get("/assets/:assetId/preview", async (c) => {
    const services = c.get("services");
    const assetId = parseAssetId(c);
    try {
      const asset = await services.resolveAsset(assetId);
      return c.redirect(
        manifestHttpUrl(asset.manifest.previewURI, services.ipfsGateway),
        302,
      );
    } catch (error) {
      if (error instanceof AssetNotFoundError) throw notFound("unknown asset");
      throw error;
    }
  });
}
