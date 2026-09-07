import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  computeConditionsHash,
  manifestPolicyHash,
  type RightsManifest,
  RightsManifestSchema,
} from "@truenft/shared";
import { network } from "hardhat";
import {
  HEDERA_TESTNET_CHAIN_ID,
  outDirFor,
  REPO_ROOT,
  readDeployment,
  writeSecretJson,
} from "./lib/deployment.js";
import { hasPinata, storeObject } from "./lib/storage.js";

const OWNER_CONDITION =
  "RightsNFT.ownerOf(tokenId) == :caller && RightsNFT.accessEpoch(tokenId) == :accessEpochAtGrant";
const LICENSE_CONDITION =
  "RightsRegistry.hasValidConsumption(:receiptHash, :useIndex)";

type StoredAsset = {
  tokenId: string;
  policyHash: `0x${string}`;
  manifest: RightsManifest;
  [key: string]: unknown;
};

type SeedArtifacts = {
  chainId: number;
  network: string;
  rightsNFT: string;
  rightsRegistry: string;
  seededAt: string;
  assets: Record<string, StoredAsset>;
};

type SeedAccounts = {
  creator: { address: string; privateKey: string };
};

/** Refreshes only the manifest condition binding after a RightsRegistry replacement. */
const { ethers, networkName } = await network.getOrCreate();

async function main(): Promise<void> {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (BigInt(chainId) !== HEDERA_TESTNET_CHAIN_ID) {
    throw new Error("refresh-manifests is restricted to Hedera testnet");
  }
  if (!hasPinata()) throw new Error("PINATA_JWT is required on Hedera testnet");
  const deployment = readDeployment(chainId);
  if (deployment === undefined) throw new Error("deployment.json is missing");

  const outDir = outDirFor(chainId);
  const artifactsPath = resolve(outDir, "seed-artifacts.json");
  const accountsPath = resolve(REPO_ROOT, `apps/e2e/.accounts.${chainId}.json`);
  const artifacts = JSON.parse(
    readFileSync(artifactsPath, "utf8"),
  ) as SeedArtifacts;
  const accounts = JSON.parse(
    readFileSync(accountsPath, "utf8"),
  ) as SeedAccounts;
  const creator = new ethers.Wallet(
    accounts.creator.privateKey,
    ethers.provider,
  );
  const nft = await ethers.getContractAt("RightsNFT", deployment.rightsNFT);
  const conditionsHash = computeConditionsHash({
    ownerCondition: OWNER_CONDITION,
    licenseCondition: LICENSE_CONDITION,
    verifyingContract: deployment.rightsRegistry,
  });

  for (const [label, stored] of Object.entries(artifacts.assets)) {
    const parsed = RightsManifestSchema.safeParse({
      ...stored.manifest,
      keyGate: { ...stored.manifest.keyGate, conditionsHash },
    });
    if (!parsed.success)
      throw new Error(`${label} manifest invalid: ${parsed.error.message}`);
    const policyHash = manifestPolicyHash(parsed.data);
    if (policyHash.toLowerCase() !== stored.policyHash.toLowerCase()) {
      throw new Error(
        `${label} policyHash changed while refreshing conditions`,
      );
    }
    const uploaded = await storeObject(
      outDir,
      `dataset-${label.toLowerCase()}.manifest.registry-${deployment.rightsRegistry.slice(2, 10)}.json`,
      new TextEncoder().encode(JSON.stringify(parsed.data, null, 2)),
      "application/json",
    );
    const tx = await nft
      .connect(creator)
      .setPolicy(BigInt(stored.tokenId), policyHash, uploaded.uri);
    await tx.wait();
    artifacts.assets[label] = {
      ...stored,
      conditionsHash,
      manifestURI: uploaded.uri,
      manifest: parsed.data,
      setPolicyTxHash: tx.hash,
    };
    console.log(
      `updated asset ${label} tokenId=${stored.tokenId} (${tx.hash})`,
    );
  }
  artifacts.network = networkName;
  artifacts.rightsRegistry = deployment.rightsRegistry;
  writeSecretJson(artifactsPath, artifacts);
  console.log(`wrote ${artifactsPath}`);
}

await main();
