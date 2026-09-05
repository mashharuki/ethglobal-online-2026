import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** apps/contracts/ */
export const CONTRACTS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
/** repository root */
export const REPO_ROOT = resolve(CONTRACTS_DIR, "../..");
export const OUT_DIR = resolve(CONTRACTS_DIR, "out");

export const HEDERA_TESTNET_CHAIN_ID = 296n;

export type DeploymentRecord = {
  chainId: number;
  network: string;
  rightsNFT: `0x${string}`;
  rightsRegistry: `0x${string}`;
  admin: `0x${string}`;
  operator: `0x${string}`;
  deployer: `0x${string}`;
  startBlock: number;
  deployedAt: string;
  txHashes: { rightsNFT: string; rightsRegistry: string };
};

export function deploymentPath(chainId: number): string {
  return resolve(OUT_DIR, `deployment.${chainId}.json`);
}

export function readDeployment(chainId: number): DeploymentRecord | undefined {
  const path = deploymentPath(chainId);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as DeploymentRecord;
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Replaces the block between `/** @deploy-writeback:start *\/` and `:end` in
 * packages/shared/src/addresses.ts with the deployed addresses (tasks.md T047).
 */
export function writeBackSharedAddresses(record: DeploymentRecord): string {
  const path = resolve(REPO_ROOT, "packages/shared/src/addresses.ts");
  const source = readFileSync(path, "utf8");
  const start = source.indexOf("/** @deploy-writeback:start */");
  const end = source.indexOf("/** @deploy-writeback:end */");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("addresses.ts write-back markers not found");
  }
  const block = [
    "/** @deploy-writeback:start */",
    "export const DEFAULT_DEPLOYMENT: Deployment = {",
    `  chainId: ${record.chainId},`,
    `  rightsNFT: "${record.rightsNFT}",`,
    `  rightsRegistry: "${record.rightsRegistry}",`,
    "};",
    "",
  ].join("\n");
  writeFileSync(path, source.slice(0, start) + block + source.slice(end));
  return path;
}

/** apps/subgraph/config/testnet.json consumed by subgraph.template.yaml (mustache). */
export function writeBackSubgraphConfig(record: DeploymentRecord): string {
  const path = resolve(REPO_ROOT, "apps/subgraph/config/testnet.json");
  writeJson(path, {
    network: "testnet",
    startBlock: record.startBlock,
    RightsNFT: record.rightsNFT,
    RightsRegistry: record.rightsRegistry,
  });
  return path;
}

export function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}
