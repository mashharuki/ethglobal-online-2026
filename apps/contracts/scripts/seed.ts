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
  outDirFor,
  REPO_ROOT,
  readDeployment,
  writeJson,
  writeSecretJson,
} from "./lib/deployment.js";
import { hasPinata, storeObject } from "./lib/storage.js";

/**
 * tasks.md T048 - demo seed.
 *
 *   pnpm --filter contracts seed:local     # deploys fresh contracts on the simulated network first
 *   pnpm --filter contracts seed:testnet   # uses out/296/deployment.json from deploy:testnet
 *
 * Creates 5 demo accounts (creator / ownerA / ownerB / buyer / agent), funds them from the
 * operator signer, encrypts the two demo datasets client-side (AES-256-GCM), splits K into
 * share_G / share_U, stores ciphertext + preview + manifest (Pinata when PINATA_JWT is set,
 * file:// otherwise - refused on testnet without --allow-local-storage), and mints asset A
 * (SURVIVE_TRANSFER, 5 HBAR, 5 uses) and asset B (INVALIDATE_ON_TRANSFER, 5 HBAR, 3 uses)
 * to ownerA. The manifest is bound to the tokenId taken from the mint receipt and attached
 * with setPolicy afterwards, so no tokenId race with concurrent mints is possible.
 *
 * Secrets are persisted BEFORE the step that depends on them (keys before funding, shares
 * before upload/mint) with 0600 permissions, per chain:
 *   out/<chainId>/seed-artifacts.json   (raw share_G / share_U - keep local)
 *   apps/e2e/.accounts.<chainId>.json   (funded test keys - gitignored)
 * Key material is NOT loaded into KV / secrets here - see apps/gateway/scripts/load-shares.ts.
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

type SeedArtifacts = {
  chainId: number;
  network: string;
  rightsNFT: string;
  rightsRegistry: string;
  seededAt: string;
  assets: Record<string, unknown>;
};

async function main(): Promise<void> {
  const [operator] = await ethers.getSigners();
  if (operator === undefined)
    throw new Error("no signer configured for this network");
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const isTestnet = BigInt(chainId) === HEDERA_TESTNET_CHAIN_ID;
  const outDir = outDirFor(chainId);
  console.log(
    `network=${networkName} chainId=${chainId} operator=${operator.address} out=${outDir}`,
  );
  if (isTestnet && !hasPinata() && !hasFlag("--allow-local-storage")) {
    throw new Error(
      "PINATA_JWT is not set: on Hedera testnet file:// URIs would be unreachable by the deployed gateway (pass --allow-local-storage to override)",
    );
  }

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
        "out/296/deployment.json not found - run deploy:testnet first",
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

  // ---- accounts: generate, PERSIST, then fund (a funding failure must never orphan funds)
  const accounts = Object.fromEntries(
    ROLES.map((role) => {
      const wallet = ethers.Wallet.createRandom().connect(ethers.provider);
      return [role, wallet] as const;
    }),
  ) as Record<Role, ReturnType<typeof ethers.Wallet.createRandom>>;

  const accountsPath = resolve(REPO_ROOT, `apps/e2e/.accounts.${chainId}.json`);
  writeSecretJson(
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
  console.log(`wrote ${accountsPath} (0600, funded test keys - gitignored)`);

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
  const artifactsPath = resolve(outDir, "seed-artifacts.json");
  const artifacts: SeedArtifacts = {
    chainId,
    network: networkName,
    rightsNFT: deployment.rightsNFT,
    rightsRegistry: deployment.rightsRegistry,
    seededAt: new Date().toISOString(),
    assets: {},
  };
  const persist = (): void => writeSecretJson(artifactsPath, artifacts);

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
    // shares are on disk before anything is uploaded or minted
    artifacts.assets[spec.key] = {
      assetId,
      transferMode: spec.transferMode,
      contentHash,
      shareG: toHex(shareG),
      shareU: toHex(shareU),
      status: "encrypted",
    };
    persist();

    const stored = await storeObject(
      outDir,
      `${spec.name}.enc`,
      ciphertext,
      "application/octet-stream",
    );
    const storedPreview = await storeObject(
      outDir,
      `${spec.name}.preview.json`,
      new Uint8Array(preview),
      "application/json",
    );

    // mint with the final policyHash but an empty manifestURI; the manifest needs the real
    // tokenId, which only the mint receipt can give us (no staticCall race)
    const policyInputManifest = {
      schemaVersion: "1.0",
      assetId,
      nftContract: deployment.rightsNFT,
      tokenId: "0",
      previewURI: storedPreview.uri,
      encryptedContentURI: stored.uri,
      contentHash,
      keyGate: {
        scheme: "xor-2share",
        keyGateVersion: 1,
        conditionsHash: computeConditionsHash({
          ownerCondition: OWNER_CONDITION,
          licenseCondition: LICENSE_CONDITION,
          verifyingContract: deployment.rightsRegistry,
        }),
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
    const draft = RightsManifestSchema.safeParse(policyInputManifest);
    if (!draft.success)
      throw new Error(`manifest ${spec.key} invalid: ${draft.error.message}`);
    const policyHash = manifestPolicyHash(draft.data);

    const creator = accounts.creator;
    const mintTx = await nft
      .connect(creator)
      .mint(
        accounts.ownerA.address,
        creator.address,
        policyHash,
        assetId,
        contentHash,
        "",
      );
    const mintReceipt = await mintTx.wait();
    const transfer = mintReceipt?.logs
      .map((log) => {
        try {
          return nft.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((parsed) => parsed?.name === "Transfer");
    if (transfer === undefined || transfer === null)
      throw new Error(`mint of asset ${spec.key} emitted no Transfer event`);
    const tokenId = transfer.args.tokenId as bigint;

    const manifest = { ...draft.data, tokenId: tokenId.toString() };
    const storedManifest = await storeObject(
      outDir,
      `${spec.name}.manifest.json`,
      new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
      "application/json",
    );
    const policyTx = await nft
      .connect(creator)
      .setPolicy(tokenId, policyHash, storedManifest.uri);
    await policyTx.wait();
    if ((await nft.policyHash(tokenId)) !== policyHash)
      throw new Error(`policyHash mismatch for asset ${spec.key}`);
    if ((await nft.manifestURI(tokenId)) !== storedManifest.uri)
      throw new Error(`manifestURI mismatch for asset ${spec.key}`);
    if ((await registry.licenseEpoch(tokenId)) !== 0n)
      throw new Error("unexpected license epoch");
    console.log(
      `minted asset ${spec.key} tokenId=${tokenId} ${spec.transferMode} (${mintTx.hash})`,
    );

    artifacts.assets[spec.key] = {
      ...(artifacts.assets[spec.key] as Record<string, unknown>),
      status: "minted",
      tokenId: tokenId.toString(),
      policyHash,
      conditionsHash: manifest.keyGate.conditionsHash,
      contentCID: stored.cid,
      previewCID: storedPreview.cid,
      encryptedContentURI: stored.uri,
      previewURI: storedPreview.uri,
      manifestURI: storedManifest.uri,
      manifest,
      mintTxHash: mintTx.hash,
      setPolicyTxHash: policyTx.hash,
      mintBlock: mintReceipt?.blockNumber ?? 0,
      localCiphertextPath: stored.localPath,
    };
    persist();
  }
  console.log(
    `wrote ${artifactsPath} (0600, contains raw share_G / share_U - keep local)`,
  );
}

await main();
