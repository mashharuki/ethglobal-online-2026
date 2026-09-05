import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  computeConditionsHash,
  manifestPolicyHash,
  type RightsManifest,
  RightsManifestSchema,
  WEIBAR_PER_HBAR,
} from "@truenft/shared";
import { network } from "hardhat";
import { keccak256, stringToHex } from "viem";
import {
  contentHashOf,
  decryptContent,
  encryptContent,
  randomBytes,
  splitKey,
  toHex,
  xorBytes,
} from "./lib/crypto.js";
import {
  CONTRACTS_DIR,
  HEDERA_TESTNET_CHAIN_ID,
  hasFlag,
  OUT_DIR,
  REPO_ROOT,
  readDeployment,
  writeJson,
} from "./lib/deployment.js";
import { storeObject } from "./lib/storage.js";

/**
 * tasks.md T048 - demo seed.
 *
 *   pnpm --filter contracts seed:local     # deploys fresh contracts on the simulated network first
 *   pnpm --filter contracts seed:testnet   # uses out/deployment.296.json from deploy:testnet
 *
 * Creates 5 demo accounts (creator / ownerA / ownerB / buyer / agent), funds them from the
 * operator signer, encrypts the two demo datasets client-side (AES-256-GCM), splits K into
 * share_G / share_U, stores ciphertext + preview + manifest (Pinata when PINATA_JWT is set,
 * file:// otherwise), and mints asset A (SURVIVE_TRANSFER, 5 HBAR, 5 uses) and asset B
 * (INVALIDATE_ON_TRANSFER, 5 HBAR, 3 uses) to ownerA.
 *
 * Key material is NOT loaded into KV / secrets here - see apps/gateway/scripts/load-shares.ts.
 * Outputs: out/seed-artifacts.json (shares in clear - keep local) and apps/e2e/.accounts.json.
 */
const { ethers, networkName } = await network.getOrCreate();

const ROLES = ["creator", "ownerA", "ownerB", "buyer", "agent"] as const;
type Role = (typeof ROLES)[number];

const FUNDING_HBAR: Record<Role, bigint> = {
  creator: 20n,
  ownerA: 20n,
  ownerB: 20n,
  buyer: 60n, // gas + several 5 HBAR purchases
  agent: 60n,
};

type AssetSpec = {
  key: "A" | "B";
  name: string;
  dataFile: string;
  previewFile: string;
  transferMode: RightsManifest["transferMode"];
  maxUses: number;
};

const ASSETS: AssetSpec[] = [
  {
    key: "A",
    name: "dataset-a",
    dataFile: "dataset-a.json",
    previewFile: "preview-a.json",
    transferMode: "SURVIVE_TRANSFER",
    maxUses: 5,
  },
  {
    key: "B",
    name: "dataset-b",
    dataFile: "dataset-b.json",
    previewFile: "preview-b.json",
    transferMode: "INVALIDATE_ON_TRANSFER",
    maxUses: 3,
  },
];

const PRICE_WEIBAR = 5n * WEIBAR_PER_HBAR;
const OWNER_CONDITION =
  "RightsNFT.ownerOf(tokenId) == :caller && RightsNFT.accessEpoch(tokenId) == :accessEpochAtGrant";
const LICENSE_CONDITION =
  "RightsRegistry.hasValidConsumption(:receiptHash, :useIndex)";

async function main(): Promise<void> {
  const [operator] = await ethers.getSigners();
  if (operator === undefined)
    throw new Error("no signer configured for this network");
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const isTestnet = BigInt(chainId) === HEDERA_TESTNET_CHAIN_ID;
  console.log(
    `network=${networkName} chainId=${chainId} operator=${operator.address}`,
  );

  // ---- contracts
  // The simulated network is per-process, so a deployment record from deploy:local is stale by
  // the time seed runs: on non-testnet chains always deploy fresh unless --use-deployment.
  let deployment =
    isTestnet || hasFlag("--use-deployment")
      ? readDeployment(chainId)
      : undefined;
  if (deployment === undefined) {
    if (isTestnet && !hasFlag("--deploy-if-missing")) {
      throw new Error(
        "out/deployment.296.json not found - run deploy:testnet first",
      );
    }
    console.log(
      "deploying fresh contracts for this run (dry run / --deploy-if-missing)",
    );
    const nft = await ethers.deployContract("RightsNFT");
    await nft.waitForDeployment();
    const registry = await ethers.deployContract("RightsRegistry", [
      await nft.getAddress(),
      operator.address,
      operator.address,
    ]);
    await registry.waitForDeployment();
    deployment = {
      chainId,
      network: networkName,
      rightsNFT: (await nft.getAddress()) as `0x${string}`,
      rightsRegistry: (await registry.getAddress()) as `0x${string}`,
      admin: operator.address as `0x${string}`,
      operator: operator.address as `0x${string}`,
      deployer: operator.address as `0x${string}`,
      startBlock: 0,
      deployedAt: new Date().toISOString(),
      txHashes: { rightsNFT: "", rightsRegistry: "" },
    };
  }
  const nft = await ethers.getContractAt("RightsNFT", deployment.rightsNFT);
  const registry = await ethers.getContractAt(
    "RightsRegistry",
    deployment.rightsRegistry,
  );

  // ---- accounts (fresh ECDSA keys; Hedera lazy-creates the account on first transfer)
  const accounts = Object.fromEntries(
    ROLES.map((role) => {
      const wallet = ethers.Wallet.createRandom().connect(ethers.provider);
      return [role, wallet] as const;
    }),
  ) as Record<Role, ReturnType<typeof ethers.Wallet.createRandom>>;

  for (const role of ROLES) {
    const to = accounts[role].address;
    const value = FUNDING_HBAR[role] * WEIBAR_PER_HBAR;
    const tx = await operator.sendTransaction({ to, value });
    await tx.wait();
    console.log(
      `funded ${role.padEnd(8)} ${to} with ${FUNDING_HBAR[role]} HBAR (${tx.hash})`,
    );
  }

  // ---- assets
  const artifacts: Record<string, unknown> = {};
  for (const spec of ASSETS) {
    const plaintext = readFileSync(
      resolve(CONTRACTS_DIR, "scripts/seed-data", spec.dataFile),
    );
    const preview = readFileSync(
      resolve(CONTRACTS_DIR, "scripts/seed-data", spec.previewFile),
    );
    const key = randomBytes(32);
    const ciphertext = await encryptContent(new Uint8Array(plaintext), key);
    const { shareG, shareU } = splitKey(key);
    // positive control: the KeyGate reconstruction (K = shareG XOR shareU) must decrypt the
    // ciphertext back to the exact plaintext before any of this is published
    const roundTrip = await decryptContent(
      ciphertext,
      xorBytes(shareG, shareU),
    );
    if (Buffer.compare(Buffer.from(roundTrip), plaintext) !== 0) {
      throw new Error(`KeyGate round-trip failed for asset ${spec.key}`);
    }
    const contentHash = contentHashOf(ciphertext);
    const assetId = keccak256(
      stringToHex(`truecollective/${chainId}/${spec.name}`),
    );

    const stored = await storeObject(
      `${spec.name}.enc`,
      ciphertext,
      "application/octet-stream",
    );
    const storedPreview = await storeObject(
      `${spec.name}.preview.json`,
      new Uint8Array(preview),
      "application/json",
    );

    // mint first so the manifest can carry the real tokenId
    const creator = accounts.creator;
    const tokenIdPreview = await nft
      .connect(creator)
      .mint.staticCall(
        accounts.ownerA.address,
        creator.address,
        ethers.ZeroHash,
        assetId,
        contentHash,
        "",
      );
    const conditionsHash = computeConditionsHash({
      ownerCondition: OWNER_CONDITION,
      licenseCondition: LICENSE_CONDITION,
      verifyingContract: deployment.rightsRegistry,
    });
    const manifestDraft = {
      schemaVersion: "1.0",
      assetId,
      nftContract: deployment.rightsNFT,
      tokenId: tokenIdPreview.toString(),
      previewURI: storedPreview.uri,
      encryptedContentURI: stored.uri,
      contentHash,
      keyGate: {
        scheme: "xor-2share",
        keyGateVersion: 1,
        conditionsHash,
        ownerCondition: OWNER_CONDITION,
        licenseCondition: LICENSE_CONDITION,
      },
      ownerAccess: { price: "0", durationSec: 3600 },
      paidAccess: {
        price: PRICE_WEIBAR.toString(),
        durationSec: 300,
        maxUses: spec.maxUses,
      },
      permissions: {
        commercialUse: false,
        aiTraining: true,
        derivativeGeneration: true,
      },
      transferMode: spec.transferMode,
      revenueSplit: { creatorBps: 3000, ownerBps: 7000 },
    };
    const parsed = RightsManifestSchema.safeParse(manifestDraft);
    if (!parsed.success)
      throw new Error(`manifest ${spec.key} invalid: ${parsed.error.message}`);
    const manifest = parsed.data;
    const policyHash = manifestPolicyHash(manifest);
    const storedManifest = await storeObject(
      `${spec.name}.manifest.json`,
      new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
      "application/json",
    );

    const mintTx = await nft
      .connect(creator)
      .mint(
        accounts.ownerA.address,
        creator.address,
        policyHash,
        assetId,
        contentHash,
        storedManifest.uri,
      );
    const mintReceipt = await mintTx.wait();
    const tokenId = tokenIdPreview;
    if ((await nft.policyHash(tokenId)) !== policyHash)
      throw new Error(`policyHash mismatch for asset ${spec.key}`);
    console.log(
      `minted asset ${spec.key} tokenId=${tokenId} ${spec.transferMode} (${mintTx.hash})`,
    );

    artifacts[spec.key] = {
      assetId,
      tokenId: tokenId.toString(),
      transferMode: spec.transferMode,
      policyHash,
      contentHash,
      conditionsHash,
      contentCID: stored.cid,
      previewCID: storedPreview.cid,
      encryptedContentURI: stored.uri,
      previewURI: storedPreview.uri,
      manifestURI: storedManifest.uri,
      manifest,
      shareG: toHex(shareG),
      shareU: toHex(shareU),
      mintTxHash: mintTx.hash,
      mintBlock: mintReceipt?.blockNumber ?? 0,
      localCiphertextPath: stored.localPath,
    };
  }

  const artifactsPath = resolve(OUT_DIR, "seed-artifacts.json");
  writeJson(artifactsPath, {
    chainId,
    network: networkName,
    rightsNFT: deployment.rightsNFT,
    rightsRegistry: deployment.rightsRegistry,
    seededAt: new Date().toISOString(),
    assets: artifacts,
  });
  console.log(
    `wrote ${artifactsPath} (contains raw share_G / share_U - keep local)`,
  );

  const accountsPath = resolve(REPO_ROOT, "apps/e2e/.accounts.json");
  writeJson(
    accountsPath,
    Object.fromEntries(
      ROLES.map((role) => [
        role,
        {
          role,
          address: accounts[role].address,
          privateKey: accounts[role].privateKey,
        },
      ]),
    ),
  );
  console.log(`wrote ${accountsPath} (funded test keys - gitignored)`);

  // sanity: registry sees the minted assets with a zero license epoch
  for (const spec of ASSETS) {
    const a = artifacts[spec.key] as { tokenId: string };
    if ((await registry.licenseEpoch(BigInt(a.tokenId))) !== 0n)
      throw new Error("unexpected license epoch");
  }
}

await main();
