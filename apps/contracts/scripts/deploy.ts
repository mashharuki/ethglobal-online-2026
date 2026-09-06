import { network } from "hardhat";
import {
  applyWrites,
  type DeploymentRecord,
  deploymentPath,
  HEDERA_TESTNET_CHAIN_ID,
  hasFlag,
  prepareGatewayWranglerWriteBack,
  prepareSharedAddressesWriteBack,
  prepareSubgraphConfigWriteBack,
  writeJson,
} from "./lib/deployment.js";

/**
 * tasks.md T047 - deploy RightsNFT -> RightsRegistry.
 *
 *   pnpm --filter contracts deploy:local     # Hardhat simulated network (dry run, no write-back)
 *   pnpm --filter contracts deploy:testnet   # --network testnet (HEDERA_RPC_URL / HEDERA_OPERATOR_KEY from keystore)
 *
 * Flags: --writeback (force write-back on non-testnet chains), --no-writeback.
 * Env:   OPERATOR_ADDRESS (gateway operator, defaults to deployer), ADMIN_ADDRESS (defaults to deployer).
 * Verification is a separate step (`pnpm --filter contracts verify:testnet`, printed at the end).
 */
const { ethers, networkName } = await network.getOrCreate();

async function main(): Promise<void> {
  const [deployer] = await ethers.getSigners();
  if (deployer === undefined)
    throw new Error("no signer configured for this network");
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const operator = (process.env.OPERATOR_ADDRESS ??
    deployer.address) as `0x${string}`;
  const admin = (process.env.ADMIN_ADDRESS ??
    deployer.address) as `0x${string}`;

  console.log(
    `network=${networkName} chainId=${chainId} deployer=${deployer.address}`,
  );
  console.log(`admin=${admin} operator=${operator}`);

  const nft = await ethers.deployContract("RightsNFT");
  const nftTx = nft.deploymentTransaction();
  await nft.waitForDeployment();
  const nftAddress = (await nft.getAddress()) as `0x${string}`;
  console.log(`RightsNFT      ${nftAddress}`);

  const registry = await ethers.deployContract("RightsRegistry", [
    nftAddress,
    admin,
    operator,
  ]);
  const registryTx = registry.deploymentTransaction();
  await registry.waitForDeployment();
  const registryAddress = (await registry.getAddress()) as `0x${string}`;
  console.log(`RightsRegistry ${registryAddress}`);

  const nftReceipt = nftTx === null ? null : await nftTx.wait();
  const record: DeploymentRecord = {
    chainId,
    network: networkName,
    rightsNFT: nftAddress,
    rightsRegistry: registryAddress,
    admin,
    operator,
    deployer: deployer.address as `0x${string}`,
    startBlock: nftReceipt?.blockNumber ?? 0,
    deployedAt: new Date().toISOString(),
    txHashes: {
      rightsNFT: nftTx?.hash ?? "",
      rightsRegistry: registryTx?.hash ?? "",
    },
  };
  const outPath = deploymentPath(chainId);
  writeJson(outPath, record);
  console.log(`wrote ${outPath}`);

  const isTestnet = BigInt(chainId) === HEDERA_TESTNET_CHAIN_ID;
  const shouldWriteBack =
    !hasFlag("--no-writeback") && (isTestnet || hasFlag("--writeback"));
  if (shouldWriteBack) {
    // prepare both destinations first so a failure cannot leave a half-applied write-back
    const written = applyWrites([
      prepareSharedAddressesWriteBack(record),
      prepareSubgraphConfigWriteBack(record),
      prepareGatewayWranglerWriteBack(record),
    ]);
    for (const path of written) console.log(`wrote ${path}`);
  } else {
    console.log(
      "write-back skipped (not Hedera testnet; pass --writeback to force)",
    );
  }

  if (isTestnet) {
    console.log("\nverify on HashScan (Sourcify):");
    console.log(`  bunx hardhat verify --network testnet ${nftAddress}`);
    console.log(
      `  bunx hardhat verify --network testnet ${registryAddress} ${nftAddress} ${admin} ${operator}`,
    );
  }
}

await main();
