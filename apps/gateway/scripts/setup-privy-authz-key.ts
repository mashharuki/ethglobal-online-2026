/**
 * One-time, human-run script (specs/mcp-auth-remediation-plan.md §1.6 "done once out-of-band"
 * step CONFIG.md documents for `PRIVY_AUTHORIZATION_PRIVATE_KEY` / `PRIVY_SIGNER_QUORUM_ID`):
 * generates the P-256 key pair the gateway uses to sign for per-principal delegated wallets
 * via Privy's `authorization_context` (no user JWT in the loop, see mcp/privyClient.ts), then
 * registers the public half as a Privy key quorum.
 *
 * The private key is NEVER printed to the terminal or returned to the caller - this script
 * pipes it straight into `wrangler secret put PRIVY_AUTHORIZATION_PRIVATE_KEY` itself. Only
 * the (non-secret) quorum id is printed, to add to `wrangler.toml`'s `[vars]` (CONFIG.md: "not
 * secret, an id not a credential").
 *
 * Usage:
 *   PRIVY_APP_ID=<app id> PRIVY_APP_SECRET=<app secret> \
 *   pnpm --filter gateway exec tsx scripts/setup-privy-authz-key.ts
 */

import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { PrivyClient } from "@privy-io/node";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function main(): Promise<void> {
  const appId = requireEnv("PRIVY_APP_ID");
  const appSecret = requireEnv("PRIVY_APP_SECRET");

  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const privateKeyBase64 = privateKey
    .export({ type: "pkcs8", format: "der" })
    .toString("base64");
  const publicKeyBase64 = publicKey
    .export({ type: "spki", format: "der" })
    .toString("base64");

  const client = new PrivyClient({ appId, appSecret });
  const quorum = await client.keyQuorums().create({
    authorization_threshold: 1,
    display_name: "TrueCollective gateway authorization key",
    public_keys: [publicKeyBase64],
  });

  console.log(`Created Privy key quorum: ${quorum.id}`);
  console.log(
    "Setting PRIVY_AUTHORIZATION_PRIVATE_KEY as a gateway secret (value never printed)...",
  );

  const result = spawnSync(
    "pnpm",
    ["exec", "wrangler", "secret", "put", "PRIVY_AUTHORIZATION_PRIVATE_KEY"],
    { input: privateKeyBase64, stdio: ["pipe", "inherit", "inherit"] },
  );
  if (result.status !== 0) {
    throw new Error(
      "wrangler secret put PRIVY_AUTHORIZATION_PRIVATE_KEY failed - see output above. " +
        "The key quorum above was still created in Privy; re-run `wrangler secret put " +
        "PRIVY_AUTHORIZATION_PRIVATE_KEY` by hand with the same key if you retry this script " +
        "(retrying end-to-end would create a redundant, harmless second quorum).",
    );
  }

  console.log("");
  console.log(
    "Done. Add this non-secret id to apps/gateway/wrangler.toml [vars]:",
  );
  console.log(`  PRIVY_SIGNER_QUORUM_ID = "${quorum.id}"`);
  console.log("Then redeploy: pnpm --filter gateway exec wrangler deploy");
}

main().catch((error: unknown) => {
  console.error("[setup-privy-authz-key] failed:", error);
  process.exitCode = 1;
});
