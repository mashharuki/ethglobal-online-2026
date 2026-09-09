import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Grep-based enforcement (specs/mcp-auth-remediation-plan.md §5): authorization-critical
 * reads must go through the cache-disabled `authzDb` handle (db/client.ts's createAuthzDb),
 * never the regular cached `db` handle - a revoked agent_grant / retired
 * agent_wallet_binding read back from a stale HYPERDRIVE cache entry must never let a request
 * through that should have been denied. This file has no runtime effect (source-level lint
 * only); it exists because that invariant can't be enforced by the type system - `db` and
 * `authzDb` are both plain `Db` at the type level, so only the call site betrays the mistake.
 */
const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../src");

// Exported grant.ts/walletProvisioning.ts functions that perform authorization-critical reads
// (agent_grant / agent_wallet_binding). A caller passing `c.get("db")` into any of these
// instead of `c.get("authzDb")` risks authorizing against a stale cached row.
const AUTHZ_CRITICAL_FUNCTIONS = [
  "resolveDelegation",
  "assertGrantUsable",
  "withGrantHeld",
  "createGrant",
  "revokeGrant",
  "revokeAllDelegations",
  "countActiveDelegations",
  "provisionAgentWallet",
];

// Files allowed to reference the HYPERDRIVE_AUTHZ binding directly - everywhere else must go
// through createAuthzDb, so a second, divergent construction path can't appear. env.ts only
// declares the binding's TYPE (it doesn't construct a client from it), so it's exempt too.
const AUTHZ_BINDING_OWNERS = ["db/client.ts", "env.ts"];

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("authorization-critical DB access", () => {
  it("should never pass the cached `db` context variable into an authorization-critical function", () => {
    const violations: string[] = [];
    for (const file of listSourceFiles(SRC_DIR)) {
      const rel = relative(SRC_DIR, file);
      if (rel === "mcp/grant.ts" || rel === "mcp/walletProvisioning.ts") {
        continue; // the definitions themselves take a generic `db: Db` parameter by design
      }
      const content = readFileSync(file, "utf8");
      for (const fn of AUTHZ_CRITICAL_FUNCTIONS) {
        const pattern = new RegExp(
          `\\b${fn}\\s*\\(\\s*[^,)]*\\bc\\.get\\(\\s*["']db["']\\s*\\)`,
        );
        if (pattern.test(content)) {
          violations.push(
            `${rel}: ${fn}(...c.get("db")...) - use c.get("authzDb") instead`,
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("should only read the HYPERDRIVE_AUTHZ binding's connectionString in db/client.ts", () => {
    // Matches actual property access on the binding (`env.HYPERDRIVE_AUTHZ.connectionString`,
    // `c.env.HYPERDRIVE_AUTHZ`, etc.), not a comment or doc-string that merely mentions the
    // binding's name - a substring match on the whole file content flagged this file's own
    // explanatory comments in index.ts as a false positive during development.
    const propertyAccess = /\bHYPERDRIVE_AUTHZ\s*\./;
    const violations: string[] = [];
    for (const file of listSourceFiles(SRC_DIR)) {
      const rel = relative(SRC_DIR, file);
      if (AUTHZ_BINDING_OWNERS.includes(rel)) continue;
      const content = readFileSync(file, "utf8");
      if (propertyAccess.test(content)) {
        violations.push(
          `${rel}: accesses HYPERDRIVE_AUTHZ directly - construct via createAuthzDb instead`,
        );
      }
    }
    expect(violations).toEqual([]);
  });
});
