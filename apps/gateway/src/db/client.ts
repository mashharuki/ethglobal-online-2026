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
