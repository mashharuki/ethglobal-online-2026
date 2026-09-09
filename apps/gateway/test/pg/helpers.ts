import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as schema from "../../src/db/schema";
import type { Db } from "../../src/db/types";

/**
 * Real-Postgres test harness (specs/mcp-auth-remediation-plan.md Phase 11): PGlite
 * (test/node/helpers.ts) is single-connection, so it cannot exercise true concurrent lock
 * contention between separate transactions - the exact scenario the spend ledger's
 * conditional-UPDATE-with-WHERE design (mcp/spend.ts) exists to survive. Tests here run
 * against a real Postgres server and issue genuinely concurrent transactions.
 */
const migrationsFolder = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../src/db/migrations",
);

export type PgTestDb = { db: Db; close: () => Promise<void> };

/**
 * Connects to a real Postgres (`DATABASE_URL_PG`) and runs migrations into a fresh, isolated
 * schema, so concurrent test files/runs against the same server never collide with each
 * other's tables or migration-tracking rows.
 *
 * Absent `DATABASE_URL_PG`: returns `undefined` (the caller should skip) UNLESS
 * `REQUIRE_PG=1` (CI's live gate, matching apps/agent's `AGENT_LIVE_REQUIRED` convention -
 * `specs/mcp-auth-remediation-plan.md` Phase 11 requires this to FAIL, not silently skip, once
 * a Postgres service container is expected to be present). A connection/setup failure always
 * throws, REQUIRE_PG or not - only a genuinely unset `DATABASE_URL_PG` is a "not configured,
 * skip" signal; a configured-but-broken connection is a real failure either way.
 */
export async function connectPgTestDb(): Promise<PgTestDb | undefined> {
  const url = process.env.DATABASE_URL_PG ?? "";
  if (url === "") {
    if (process.env.REQUIRE_PG === "1") {
      throw new Error("DATABASE_URL_PG is required (REQUIRE_PG=1)");
    }
    return undefined;
  }

  // "pg_" is a reserved schema-name prefix in Postgres (CREATE SCHEMA rejects it outright).
  const schemaName = `test_pg_${randomUUID().replaceAll("-", "_")}`;
  const admin = postgres(url, { max: 1 });
  try {
    await admin.unsafe(`CREATE SCHEMA "${schemaName}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }

  const sql = postgres(url, {
    max: 20, // >= the highest concurrency any test here fires, so no test queues on the pool itself
    connection: { search_path: schemaName },
  });
  const db = drizzle(sql, { schema });
  await migrate(db, { migrationsFolder, migrationsSchema: schemaName });

  return {
    db: db as unknown as Db,
    close: async () => {
      await sql.end({ timeout: 5 });
      const cleanup = postgres(url, { max: 1 });
      try {
        await cleanup.unsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      } finally {
        await cleanup.end({ timeout: 5 });
      }
    },
  };
}
