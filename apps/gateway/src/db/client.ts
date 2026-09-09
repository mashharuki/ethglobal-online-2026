import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { Env } from "../env";
import * as schema from "./schema";
import type { Db } from "./types";

/**
 * Hyperdrive-backed Postgres connection factory (tasks.md T075). One client per request
 * (Workers have no long-lived process); Hyperdrive pools on its side. Migrations are applied
 * out of band with `pnpm --filter gateway db:migrate` (drizzle-kit, node) - the Worker never
 * runs DDL.
 */
export type DbHandle = { db: Db; close: () => Promise<void> };

export function createDb(env: Env): DbHandle {
  const sql = postgres(env.HYPERDRIVE.connectionString, {
    max: 5,
    // Hyperdrive already caches type OIDs; skipping the round-trip speeds cold requests.
    fetch_types: false,
    prepare: false,
  });
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
 * test/node/authzHandle.test.ts greps the rest of src/ to enforce that call sites doing those
 * reads pass this handle, not createDb's. Do not read env.HYPERDRIVE_AUTHZ.connectionString
 * anywhere else - that grep-based encapsulation check also asserts this is the only file that
 * does.
 */
export function createAuthzDb(env: Env): DbHandle {
  const sql = postgres(env.HYPERDRIVE_AUTHZ.connectionString, {
    max: 5,
    fetch_types: false,
    prepare: false,
  });
  const db = drizzle(sql, { schema });
  return {
    db,
    close: async () => {
      await sql.end({ timeout: 5 });
    },
  };
}
