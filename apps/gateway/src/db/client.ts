import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { Env } from "../env";
import * as schema from "./schema";
import type { AuthzDb, Db } from "./types";

/**
 * Hyperdrive-backed Postgres connection factory (tasks.md T075). One client per request
 * (Workers have no long-lived process); Hyperdrive pools on its side. Migrations are applied
 * out of band with `pnpm --filter gateway db:migrate` (drizzle-kit, node) - the Worker never
 * runs DDL.
 */
export type DbHandle = { db: Db; close: () => Promise<void> };

function openPostgres(connectionString: string) {
  return postgres(connectionString, {
    max: 5,
    // Hyperdrive already caches type OIDs; skipping the round-trip speeds cold requests.
    fetch_types: false,
    prepare: false,
  });
}

export function createDb(env: Env): DbHandle {
  const sql = openPostgres(env.HYPERDRIVE.connectionString);
  const db = drizzle(sql, { schema });
  return {
    db,
    close: async () => {
      await sql.end({ timeout: 5 });
    },
  };
}

/**
 * Same Postgres, through the cache-disabled HYPERDRIVE_AUTHZ binding (env.ts,
 * specs/mcp-auth-remediation-plan.md §5) - the ONLY handle authorization-critical reads
 * (agent_grant, agent_wallet_binding, oauth_token, mcp_authenticated_session) may use.
 * Functions that do those reads (grant.ts, walletProvisioning.ts) require `AuthzDb`, not
 * plain `Db`, so passing the wrong handle at a call site is a compile error - this is the one
 * place that may cast to it (test/node/authzHandle.test.ts's grep-based encapsulation check
 * also asserts this is the only file that reads env.HYPERDRIVE_AUTHZ directly, as defense in
 * depth alongside the type check).
 */
export function createAuthzDb(env: Env): {
  db: AuthzDb;
  close: () => Promise<void>;
} {
  const sql = openPostgres(env.HYPERDRIVE_AUTHZ.connectionString);
  const db = drizzle(sql, { schema }) as unknown as AuthzDb;
  return {
    db,
    close: async () => {
      await sql.end({ timeout: 5 });
    },
  };
}
