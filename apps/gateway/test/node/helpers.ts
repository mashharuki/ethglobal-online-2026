import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import {
  computeConditionsHash,
  computeResourceHash,
  encryptShareG,
  manifestPolicyHash,
  type RightsManifest,
  shareGKvKey,
} from "@truenft/shared";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { type Address, bytesToHex, type Hex, hexToBytes } from "viem";
import * as schema from "../../src/db/schema";
import type { Db } from "../../src/db/types";
import type { Env } from "../../src/env";
import { shareUSecretName } from "../../src/keygate/vault";

/** Shared fixtures for the node (PGlite) suite. Chain access is injected per test. */
const migrationsFolder = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../src/db/migrations",
);

export async function createTestDb(): Promise<{ db: Db; client: PGlite }> {
  const client = new PGlite();
  const pglite = drizzle(client, { schema });
  await migrate(pglite, { migrationsFolder });
  return { db: pglite as unknown as Db, client };
}

/** Minimal in-memory stand-in for the SHARE_G KV binding (storage only, no logic). */
export class MemoryKv {
  private readonly store = new Map<string, string>();
  async get(key: string, _type?: "text"): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

export const CHAIN_ID = 296;
export const RIGHTS_NFT: Address = "0x1111111111111111111111111111111111111111";
export const RIGHTS_REGISTRY: Address =
  "0x2222222222222222222222222222222222222222";
export const KEK = `0x${"11".repeat(32)}` as Hex;
export const RECEIPT_SIGNER_KEY = `0x${"0f".repeat(32)}` as Hex;

export type TestAsset = {
  assetId: Hex;
  tokenId: bigint;
  manifest: RightsManifest;
  shareG: Uint8Array;
  shareU: Uint8Array;
  contentKey: Uint8Array;
  policyHash: Hex;
  resourceHash: Hex;
};

export function buildAsset(
  byte: string,
  options: { tokenId?: bigint; maxUses?: number; contentHash?: Hex } = {},
): TestAsset {
  const assetId = `0x${byte.repeat(32)}` as Hex;
  const tokenId = options.tokenId ?? 1n;
  const contentHash = options.contentHash ?? (`0x${"c0".repeat(32)}` as Hex);
  const conditionsHash = computeConditionsHash({
    ownerCondition: "ownerOf(tokenId) == caller",
    licenseCondition: "hasValidConsumption(receiptHash, useIndex)",
    verifyingContract: RIGHTS_REGISTRY,
  });
  const manifest: RightsManifest = {
    schemaVersion: "1.0",
    assetId,
    nftContract: RIGHTS_NFT,
    tokenId: tokenId.toString(),
    previewURI: "https://example.invalid/preview.png",
    encryptedContentURI: "ipfs://bafyencrypted",
    contentHash,
    keyGate: {
      scheme: "xor-2share",
      keyGateVersion: 1,
      conditionsHash,
      ownerCondition: "ownerOf(tokenId) == caller",
      licenseCondition: "hasValidConsumption(receiptHash, useIndex)",
    },
    ownerAccess: { price: "0", durationSec: 3600 },
    paidAccess: {
      price: "5000000000000000000",
      durationSec: 300,
      maxUses: options.maxUses ?? 5,
    },
    permissions: {
      commercialUse: true,
      aiTraining: true,
      derivativeGeneration: false,
    },
    transferMode: "SURVIVE_TRANSFER",
    revenueSplit: { creatorBps: 3000, ownerBps: 7000 },
  };
  const contentKey = hexToBytes(`0x${"77".repeat(32)}`);
  const shareG = hexToBytes(`0x${"33".repeat(32)}`);
  const shareU = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1)
    shareU[i] = (contentKey[i] ?? 0) ^ (shareG[i] ?? 0);
  return {
    assetId,
    tokenId,
    manifest,
    shareG,
    shareU,
    contentKey,
    policyHash: manifestPolicyHash(manifest),
    resourceHash: computeResourceHash({
      nftContract: RIGHTS_NFT,
      tokenId,
      assetId,
      contentHash,
    }),
  };
}

export async function makeEnv(
  kv: MemoryKv,
  assets: TestAsset[],
  overrides: Partial<Env> = {},
): Promise<Env> {
  const env: Record<string, unknown> = {
    HEDERA_CHAIN_ID: String(CHAIN_ID),
    HEDERA_RPC_URL: "https://relay.invalid/api",
    X402_FACILITATOR_URL: "https://facilitator.invalid",
    PAYMENT_ASSET: "native",
    SETTLEMENT_MODE: "primary",
    SUBGRAPH_URL: "",
    RIGHTS_NFT_ADDRESS: RIGHTS_NFT,
    RIGHTS_REGISTRY_ADDRESS: RIGHTS_REGISTRY,
    IPFS_GATEWAY_URL: "https://ipfs.invalid",
    KV_KEK: KEK,
    RECEIPT_SIGNER_KEY,
    SHARE_G: kv,
    ...overrides,
  };
  for (const asset of assets) {
    env[shareUSecretName(asset.assetId)] = bytesToHex(asset.shareU);
    await kv.put(
      shareGKvKey(asset.assetId),
      await encryptShareG(asset.shareG, hexToBytes(KEK), asset.assetId),
    );
  }
  return env as unknown as Env;
}
