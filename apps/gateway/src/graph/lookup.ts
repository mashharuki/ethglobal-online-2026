import type { Hex } from "viem";

/**
 * Discovery-only subgraph lookup (FR-020, constitution II): returns the tokenId the Rights
 * Graph associates with an assetId. It is a HINT - manifest/resolver.ts proves the mapping
 * on chain before anything is released. Missing SUBGRAPH_URL or a failed query simply yields
 * undefined (asset unknown), never a grant.
 */
const QUERY = `query TokenByAsset($assetId: Bytes!) {
  rightsTokens(where: { assetId: $assetId }, first: 1) { tokenId }
}`;

type GraphResponse = {
  data?: { rightsTokens?: Array<{ tokenId: string }> };
  errors?: Array<{ message: string }>;
};

export async function lookupTokenIdByAssetId(
  subgraphUrl: string,
  assetId: Hex,
  fetchImpl: typeof fetch = fetch,
): Promise<bigint | undefined> {
  if (subgraphUrl === "") return undefined;
  const response = await fetchImpl(subgraphUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query: QUERY,
      variables: { assetId: assetId.toLowerCase() },
    }),
  });
  if (!response.ok) return undefined;
  const body = (await response.json()) as GraphResponse;
  const tokenId = body.data?.rightsTokens?.[0]?.tokenId;
  if (tokenId === undefined || !/^\d+$/.test(tokenId)) return undefined;
  return BigInt(tokenId);
}
