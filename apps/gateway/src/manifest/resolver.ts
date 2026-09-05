import {
  type Deployment,
  manifestAddresses,
  parseManifest,
  type RightsManifest,
} from "@truenft/shared";
import { type Address, type Hex, isAddressEqual } from "viem";
import { AppError } from "../errors";

/**
 * assetId -> (tokenId, manifest) resolution (tasks.md T081, R-11). Clients never send a
 * tokenId: the gateway looks the assetId up (subgraph / cache = a HINT only), then proves the
 * mapping on chain (`RightsNFT.assetId(tokenId)` must equal the requested assetId) and loads
 * the manifest from `manifestURI(tokenId)`. Everything the manifest claims about identity
 * (assetId, tokenId, nftContract) is checked against the chain before it is trusted.
 */
/** @lintignore mapped to 404 by the routes (tasks.md T086/T087) */
export class AssetNotFoundError extends Error {
  override readonly name = "AssetNotFoundError";
  constructor(readonly assetId: Hex) {
    super(`unknown asset ${assetId}`);
  }
}

export type ResolvedAsset = {
  assetId: Hex;
  tokenId: bigint;
  nftContract: Address;
  manifest: RightsManifest;
};

export type ManifestPorts = {
  /** discovery hint (subgraph / cache); undefined when unknown */
  lookupTokenId(assetId: Hex): Promise<bigint | undefined>;
  /** chain: RightsNFT.assetId(tokenId) */
  readAssetId(tokenId: bigint): Promise<Hex>;
  /** chain: RightsNFT.manifestURI(tokenId) */
  readManifestURI(tokenId: bigint): Promise<string>;
  /** IPFS gateway fetch of the manifest JSON */
  fetchManifest(uri: string): Promise<unknown>;
};

export async function resolveAsset(
  ports: ManifestPorts,
  deployment: Deployment,
  assetId: Hex,
): Promise<ResolvedAsset> {
  const tokenId = await ports.lookupTokenId(assetId);
  if (tokenId === undefined) throw new AssetNotFoundError(assetId);
  const onChainAssetId = await ports.readAssetId(tokenId);
  if (onChainAssetId.toLowerCase() !== assetId.toLowerCase()) {
    // stale / poisoned hint: the chain says this token is a different asset
    throw new AssetNotFoundError(assetId);
  }
  const uri = await ports.readManifestURI(tokenId);
  if (uri === "") throw new AssetNotFoundError(assetId);
  const parsed = parseManifest(await ports.fetchManifest(uri));
  if (!parsed.ok) {
    throw new AppError("MANIFEST_SCHEMA_INVALID", undefined, {
      issues: parsed.error.issues.map((i) => i.message).slice(0, 5),
    });
  }
  const manifest = parsed.data;
  const addresses = manifestAddresses(manifest);
  if (
    manifest.assetId.toLowerCase() !== assetId.toLowerCase() ||
    addresses.tokenId !== tokenId ||
    !isAddressEqual(addresses.nftContract, deployment.rightsNFT)
  ) {
    throw new AppError(
      "MANIFEST_SCHEMA_INVALID",
      "manifest identity does not match the on-chain token",
      {
        manifestAssetId: manifest.assetId,
        manifestTokenId: manifest.tokenId,
        manifestNftContract: manifest.nftContract,
      },
    );
  }
  return {
    assetId,
    tokenId,
    nftContract: addresses.nftContract,
    manifest,
  };
}

/** ipfs://<cid>/<path> -> <gateway>/ipfs/<cid>/<path>; http(s) passes through. */
export function manifestHttpUrl(uri: string, ipfsGateway: string): string {
  if (uri.startsWith("ipfs://")) {
    const base = ipfsGateway.endsWith("/") ? ipfsGateway : `${ipfsGateway}/`;
    return `${base}ipfs/${uri.slice("ipfs://".length)}`;
  }
  if (uri.startsWith("https://") || uri.startsWith("http://")) return uri;
  throw new AppError(
    "MANIFEST_SCHEMA_INVALID",
    `unsupported manifest URI ${uri}`,
  );
}
