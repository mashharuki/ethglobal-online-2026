import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** apps/contracts/ */
export const CONTRACTS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
/** repository root */
export const REPO_ROOT = resolve(CONTRACTS_DIR, "../..");
const OUT_DIR = resolve(CONTRACTS_DIR, "out");

export const HEDERA_TESTNET_CHAIN_ID = 296n;

/** Per-chain output directory so a local dry run never overwrites testnet artifacts. */
export function outDirFor(chainId: number): string {
  return resolve(OUT_DIR, String(chainId));
}

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
  return resolve(outDirFor(chainId), "deployment.json");
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

/** Owner-only file for private keys / key shares (0600, enforced on existing files too). */
export function writeSecretJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export type PreparedWrite = { path: string; content: string };

/**
 * Builds the write-back for packages/shared/src/addresses.ts (block between the
 * `@deploy-writeback:start/end` markers, tasks.md T047) without touching the disk.
 */
export function prepareSharedAddressesWriteBack(
  record: DeploymentRecord,
): PreparedWrite {
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
  return { path, content: source.slice(0, start) + block + source.slice(end) };
}

/** apps/subgraph/config/testnet.json consumed by subgraph.template.yaml (mustache). */
export function prepareSubgraphConfigWriteBack(
  record: DeploymentRecord,
): PreparedWrite {
  const path = resolve(REPO_ROOT, "apps/subgraph/config/testnet.json");
  const content = `${JSON.stringify(
    {
      network: "testnet",
      startBlock: record.startBlock,
      RightsNFT: record.rightsNFT,
      RightsRegistry: record.rightsRegistry,
    },
    null,
    2,
  )}\n`;
  return { path, content };
}

/**
 * apps/gateway/wrangler.toml's RIGHTS_NFT_ADDRESS / RIGHTS_REGISTRY_ADDRESS [vars] - these
 * override packages/shared's DEFAULT_DEPLOYMENT (T047 above) for the deployed Worker, so a
 * redeploy that skips this write-back leaves the gateway pointed at stale contracts while
 * web/subgraph move to the new ones (#49). Line-anchored regex, not a TOML parser: both keys
 * are unique top-level [vars] entries, so a substring match can't collide with anything else.
 */
export function prepareGatewayWranglerWriteBack(
  record: DeploymentRecord,
): PreparedWrite {
  const path = resolve(REPO_ROOT, "apps/gateway/wrangler.toml");
  const source = readFileSync(path, "utf8");
  const replacements: Array<[RegExp, string]> = [
    [
      /^RIGHTS_NFT_ADDRESS = ".*"$/m,
      `RIGHTS_NFT_ADDRESS = "${record.rightsNFT}"`,
    ],
    [
      /^RIGHTS_REGISTRY_ADDRESS = ".*"$/m,
      `RIGHTS_REGISTRY_ADDRESS = "${record.rightsRegistry}"`,
    ],
  ];
  let content = source;
  for (const [pattern, replacement] of replacements) {
    if (!pattern.test(content)) {
      throw new Error(
        `wrangler.toml write-back: pattern not found (${pattern}) - has the [vars] block moved or been renamed?`,
      );
    }
    content = content.replace(pattern, replacement);
  }
  return { path, content };
}

/** Validates every destination first, then writes all of them (no half-applied write-back). */
export function applyWrites(writes: PreparedWrite[]): string[] {
  for (const w of writes) {
    if (!existsSync(dirname(w.path)))
      throw new Error(`write-back target dir missing: ${dirname(w.path)}`);
  }
  for (const w of writes) writeFileSync(w.path, w.content);
  return writes.map((w) => w.path);
}

export function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}
