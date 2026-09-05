import type { Address, Hex } from "viem";
import { type ChainContext, createChainContext } from "../chain/clients";
import {
  readAssetId,
  readManifestURI,
  readOwnerSnapshot,
  readPolicyHash,
  readReceiptStatus,
  readResourceHash,
} from "../chain/reads";
import type { Db } from "../db/types";
import { consumeViaReceiptLock } from "../do/client";
import type { Env } from "../env";
import { lookupTokenIdByAssetId } from "../graph/lookup";
import {
  type ManifestPorts,
  manifestHttpUrl,
  resolveAsset,
} from "../manifest/resolver";
import type { ReleasePorts } from "./release";

/**
 * Production wiring of the release decision: chain reads via viem (authority), assetId
 * lookup via the subgraph hint + on-chain proof, consume via the ReceiptLock DO.
 * @lintignore consumed by routes/ownerAccess + routes/keygate (tasks.md T087/T089)
 */
export function createManifestPorts(
  env: Env,
  ctx: ChainContext,
): ManifestPorts {
  return {
    lookupTokenId: (assetId) =>
      lookupTokenIdByAssetId(env.SUBGRAPH_URL, assetId),
    readAssetId: (tokenId) => readAssetId(ctx, tokenId),
    readManifestURI: (tokenId) => readManifestURI(ctx, tokenId),
    fetchManifest: async (uri) => {
      const response = await fetch(manifestHttpUrl(uri, env.IPFS_GATEWAY_URL));
      if (!response.ok) {
        throw new Error(`manifest fetch failed (${response.status})`);
      }
      return response.json();
    },
  };
}

/** @lintignore consumed by routes/ownerAccess + routes/keygate (tasks.md T087/T089) */
export function createReleasePorts(env: Env, db: Db): ReleasePorts {
  const ctx = createChainContext(env);
  const manifestPorts = createManifestPorts(env, ctx);
  return {
    env,
    db,
    deployment: ctx.deployment,
    chain: {
      ownerSnapshot: async (tokenId) => {
        const s = await readOwnerSnapshot(ctx, tokenId);
        return {
          owner: s.owner,
          accessEpoch: s.accessEpoch,
          policyHash: s.policyHash,
          resourceHash: s.resourceHash,
        };
      },
      tokenHashes: async (tokenId) => {
        const blockNumber = await ctx.publicClient.getBlockNumber();
        const [policyHash, resourceHash] = await Promise.all([
          readPolicyHash(ctx, tokenId, { blockNumber }),
          readResourceHash(ctx, tokenId, { blockNumber }),
        ]);
        return { policyHash, resourceHash };
      },
      receiptStatus: async (receiptHash: Hex) => {
        const s = await readReceiptStatus(ctx, receiptHash);
        return {
          issued: s.issued,
          tokenId: s.tokenId,
          licensee: s.licensee,
          maxUses: s.maxUses,
          usedCount: s.usedCount,
          expiresAt: s.expiresAt,
        };
      },
      getCode: (address: Address) => ctx.publicClient.getCode({ address }),
    },
    resolveAsset: (assetId) =>
      resolveAsset(manifestPorts, ctx.deployment, assetId),
    consume: async (input) => {
      const outcome = await consumeViaReceiptLock(env, input);
      if (outcome.onchainTx === undefined) {
        // recovered from a crash before the tx hash was recorded: the consumption is
        // confirmed on chain (consumed[receipt][idx] == true) but the hash is unknown
        return {
          useIndex: outcome.useIndex,
          onchainTx: `0x${"00".repeat(32)}`,
        };
      }
      return { useIndex: outcome.useIndex, onchainTx: outcome.onchainTx };
    },
    now: () => new Date(),
  };
}
