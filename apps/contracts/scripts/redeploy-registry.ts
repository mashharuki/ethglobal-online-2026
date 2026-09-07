import { network } from "hardhat";
import {
  applyWrites,
  type DeploymentRecord,
  deploymentPath,
  HEDERA_TESTNET_CHAIN_ID,
  prepareGatewayWranglerWriteBack,
  prepareSharedAddressesWriteBack,
  prepareSubgraphConfigWriteBack,
  readDeployment,
  writeJson,
} from "./lib/deployment.js";

/**
 * Replaces RightsRegistry while preserving the deployed RightsNFT and its minted assets.
 * Use this for registry-only fixes so existing token IDs, manifests, and key shares remain valid.
 */
const { ethers, networkName } = await network.getOrCreate();

async function main(): Promise<void> {
  const [deployer] = await ethers.getSigners();
  if (deployer === undefined) throw new Error("no signer configured");
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (BigInt(chainId) !== HEDERA_TESTNET_CHAIN_ID) {
    throw new Error("redeploy-registry is restricted to Hedera testnet");
  }
  const previous = readDeployment(chainId);
  if (previous === undefined)
    throw new Error("existing deployment.json is missing");

  const admin = (process.env.ADMIN_ADDRESS ??
    deployer.address) as `0x${string}`;
  const operator = (process.env.OPERATOR_ADDRESS ??
    deployer.address) as `0x${string}`;
  const registry = await ethers.deployContract("RightsRegistry", [
    previous.rightsNFT,
    admin,
    operator,
  ]);
  const registryTx = registry.deploymentTransaction();
  await registry.waitForDeployment();
  const rightsRegistry = (await registry.getAddress()) as `0x${string}`;

  const record: DeploymentRecord = {
    ...previous,
    network: networkName,
    rightsRegistry,
    admin,
    operator,
    deployer: deployer.address as `0x${string}`,
    deployedAt: new Date().toISOString(),
    txHashes: {
      rightsNFT: previous.txHashes.rightsNFT,
      rightsRegistry: registryTx?.hash ?? "",
    },
  };
  const outPath = deploymentPath(chainId);
  writeJson(outPath, record);
  for (const path of applyWrites([
    prepareSharedAddressesWriteBack(record),
    prepareSubgraphConfigWriteBack(record),
    prepareGatewayWranglerWriteBack(record),
  ])) {
    console.log(`wrote ${path}`);
  }
  console.log(`RightsNFT      ${record.rightsNFT} (preserved)`);
  console.log(`RightsRegistry ${rightsRegistry}`);
  console.log(
    `verify: bunx hardhat verify --network testnet ${rightsRegistry} ${record.rightsNFT} ${admin} ${operator}`,
  );
}

await main();
