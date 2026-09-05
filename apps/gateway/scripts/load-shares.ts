// tasks.md T076: load seed key shares into the deployed gateway.
//   KV_KEK=<32-byte hex> pnpm --filter gateway load-shares -- [--chain-id 296] [--dry-run] [--local]
//
// Reads apps/contracts/out/<chainId>/seed-artifacts.json (written by apps/contracts seed, T048),
// encrypts each asset's share_G with KV_KEK using packages/shared kv-format (the same module the
// gateway decrypts with) and puts it into the SHARE_G KV namespace; share_U goes to the Worker
// secret SHARE_U_<assetId> via `wrangler secret put` (stdin, never a CLI argument).
// Ordering: `wrangler secret put` needs the Worker to exist, so run this after the first
// `wrangler deploy` (T097) and re-deploy afterwards. Share values are never printed.
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { encryptShareG, shareGKvKey } from "@truenft/shared";
import { type Hex, hexToBytes } from "viem";
import { readKek, shareUSecretName } from "../src/keygate/vault";

type SeedAsset = { assetId: Hex; shareG: Hex; shareU: Hex; tokenId: string };
type SeedArtifacts = { chainId: number; assets: Record<string, SeedAsset> };

function parseArgs(argv: string[]): {
  chainId: number;
  dryRun: boolean;
  local: boolean;
} {
  let chainId = Number.parseInt(process.env.HEDERA_CHAIN_ID ?? "296", 10);
  let dryRun = false;
  let local = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--chain-id") {
      chainId = Number.parseInt(argv[i + 1] ?? "", 10);
      i += 1;
    } else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--local") local = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  if (Number.isNaN(chainId)) throw new Error("--chain-id must be a number");
  return { chainId, dryRun, local };
}

/** Owner-only file: refuses symlinks and forces 0600 even when the file already exists. */
function writeOwnerOnlyFile(path: string, content: string): void {
  let existing: ReturnType<typeof lstatSync> | undefined;
  try {
    existing = lstatSync(path);
  } catch {
    existing = undefined;
  }
  if (existing?.isSymbolicLink()) {
    throw new Error(
      `${path} is a symlink; refusing to write secrets through it`,
    );
  }
  writeFileSync(path, content, { mode: 0o600, flag: "w" });
  chmodSync(path, 0o600);
}

function wrangler(args: string[], input?: string): void {
  execFileSync("pnpm", ["exec", "wrangler", ...args], {
    cwd: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
    stdio: [input === undefined ? "ignore" : "pipe", "inherit", "inherit"],
    input,
  });
}

async function main(): Promise<void> {
  const { chainId, dryRun, local } = parseArgs(process.argv.slice(2));
  const here = dirname(fileURLToPath(import.meta.url));
  const artifactsPath = resolve(
    here,
    `../../contracts/out/${chainId}/seed-artifacts.json`,
  );
  const artifacts = JSON.parse(
    readFileSync(artifactsPath, "utf8"),
  ) as SeedArtifacts;
  if (artifacts.chainId !== chainId) {
    throw new Error(
      `${artifactsPath} is for chain ${artifacts.chainId}, not ${chainId}`,
    );
  }
  const kek = readKek({ KV_KEK: process.env.KV_KEK });
  const outDir = resolve(here, `../out/${chainId}`);
  mkdirSync(outDir, { recursive: true });

  const plan: Array<{
    label: string;
    assetId: Hex;
    kvKey: string;
    blob: string;
    secretName: string;
  }> = [];
  for (const [label, asset] of Object.entries(artifacts.assets)) {
    const blob = await encryptShareG(
      hexToBytes(asset.shareG),
      kek,
      asset.assetId,
    );
    plan.push({
      label,
      assetId: asset.assetId,
      kvKey: shareGKvKey(asset.assetId),
      blob,
      secretName: shareUSecretName(asset.assetId),
    });
  }
  kek.fill(0);

  if (dryRun) {
    const file = resolve(outDir, "load-shares.dry-run.json");
    // blobs are KEK ciphertext; share_U is deliberately NOT included
    writeOwnerOnlyFile(file, `${JSON.stringify(plan, null, 2)}\n`);
    console.log(
      `dry run: wrote ${file} (${plan.length} assets, no wrangler calls)`,
    );
    return;
  }

  const devVarsLines: string[] = [];
  for (const item of plan) {
    const asset = artifacts.assets[item.label];
    if (asset === undefined) throw new Error(`asset ${item.label} vanished`);
    console.log(`[${item.label}] kv put ${item.kvKey}`);
    wrangler([
      "kv",
      "key",
      "put",
      item.kvKey,
      item.blob,
      "--binding",
      "SHARE_G",
      ...(local ? ["--local"] : ["--remote"]),
    ]);
    if (local) {
      devVarsLines.push(`${item.secretName}=${asset.shareU}`);
    } else {
      console.log(`[${item.label}] secret put ${item.secretName}`);
      wrangler(["secret", "put", item.secretName], `${asset.shareU}\n`);
    }
  }
  if (local) {
    const file = resolve(outDir, "share-u.dev.vars");
    writeOwnerOnlyFile(file, `${devVarsLines.join("\n")}\n`);
    console.log(
      `local mode: append ${file} to apps/gateway/.dev.vars (0600, never commit)`,
    );
  }
  console.log(
    `loaded ${plan.length} assets; re-run wrangler deploy to pick up secrets`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
