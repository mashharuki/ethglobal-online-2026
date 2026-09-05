import { parseManifest } from "@truenft/shared";
import type { Hex } from "viem";
import {
  cachedGraphQuery,
  type GraphToken,
  LIST_TOKENS_QUERY,
} from "../graph/cache";
import type { Services } from "../services";

/**
 * Discovery listing shared by GET /assets and the MCP `discover_assets` tool (FR-019 /
 * FR-020). Nothing here authorizes anything: the list comes from the subgraph (+ cache) and
 * manifests are expanded as published.
 */
export type AssetSummary = {
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

export async function listAssets(services: Services): Promise<AssetSummary[]> {
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
  return summaries;
}
