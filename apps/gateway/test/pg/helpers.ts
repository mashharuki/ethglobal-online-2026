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

export type PgTestDb = {
  db: Db;
  /** the raw postgres.js client, for introspection queries (pg_stat_activity) a
   * drizzle-wrapped `db` has no escape hatch for - see observeMaxConcurrentActive below. */
  sql: postgres.Sql;
  /** this pool's `application_name` (unique per connectPgTestDb call) - the precise filter
   * observeMaxConcurrentActive uses to count only THIS test's own backends, not unrelated
   * activity that might be running against the same shared Postgres server. */
  applicationName: string;
  close: () => Promise<void>;
};

async function dropSchema(url: string, schemaName: string): Promise<void> {
  const cleanup = postgres(url, { max: 1 });
  try {
    await cleanup.unsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
  } finally {
    await cleanup.end({ timeout: 5 });
  }
}

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
 *
 * Codex review: a failure partway through setup (schema created but migration fails, or the
 * pool fails to open) used to leak both the schema and any open connections, since the
 * function threw before returning anything for a caller to clean up. Every failure path below
 * now tears down whatever it already created before rethrowing.
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

  const applicationName = `gateway-pg-test-${schemaName}`;
  let sql: postgres.Sql | undefined;
  try {
    sql = postgres(url, {
      max: 20, // >= the highest concurrency any test here fires, so no test queues on the pool itself
      connection: {
        search_path: schemaName,
        application_name: applicationName,
      },
    });
    const db = drizzle(sql, { schema });
    await migrate(db, { migrationsFolder, migrationsSchema: schemaName });

    return {
      db: db as unknown as Db,
      sql,
      applicationName,
      close: async () => {
        await sql?.end({ timeout: 5 });
        await dropSchema(url, schemaName);
      },
    };
  } catch (error) {
    await sql?.end({ timeout: 5 }).catch(() => {});
    await dropSchema(url, schemaName).catch(() => {});
    throw error;
  }
}

/**
 * Polls `pg_stat_activity` while `stop.done` is false and returns the highest number of
 * distinct backends it ever observed simultaneously `active` under `applicationName` - i.e.
 * genuinely overlapping transactions FROM THIS TEST'S OWN CONNECTION POOL specifically, not
 * incidental activity from anything else that might be running against the same shared
 * Postgres server.
 *
 * This exists because "fire N promises with Promise.allSettled" only proves N requests were
 * ISSUED concurrently at the JS level (Codex review) - it does not, by itself, prove the
 * database ever actually ran overlapping transactions. Without this, a test asserting only the
 * final outcome could pass identically whether the 20 calls truly raced inside Postgres or
 * were serialized by some incidental bottleneck (a starved pool, an accidental global lock) -
 * exactly the distinction this whole suite exists to exercise that PGlite cannot. Sampling at
 * a fixed interval cannot GUARANTEE catching every overlap, but observing >=2 is direct,
 * positive evidence of real concurrent execution, not an assumption about how promises are
 * scheduled.
 */
export async function observeMaxConcurrentActive(
  probe: postgres.Sql,
  applicationName: string,
  stop: { done: boolean },
): Promise<number> {
  let max = 0;
  while (!stop.done) {
    const rows = await probe<{ n: number }[]>`
      SELECT count(DISTINCT pid)::int AS n
      FROM pg_stat_activity
      WHERE state = 'active'
        AND application_name = ${applicationName}
    `;
    const n = rows[0]?.n ?? 0;
    if (n > max) max = n;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  return max;
}
