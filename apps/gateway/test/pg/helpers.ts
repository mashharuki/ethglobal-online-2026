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
 * Runs every step regardless of whether an earlier one failed, then throws if any did
 * (Codex review, round 2: `close()`/`connectPgTestDb`'s failure path used to run cleanup steps
 * sequentially with a bare `await`, so the first one to reject skipped every step after it -
 * e.g. a pool that fails to close would leave the schema undropped even though dropping it has
 * nothing to do with the pool). Each step here is independent and always attempted.
 */
async function runAllSettling<T>(
  steps: ReadonlyArray<() => Promise<T>>,
): Promise<void> {
  const results = await Promise.allSettled(steps.map((step) => step()));
  const errors = results
    .filter((r): r is PromiseRejectedResult => r.status === "rejected")
    .map((r) => r.reason);
  if (errors.length > 0) {
    throw new AggregateError(errors, "pg test cleanup step(s) failed");
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
 * Codex review (round 2): tracks `schemaCreated` explicitly, independent of whether the admin
 * connection's own `.end()` succeeds, so a schema that was actually created is always a
 * candidate for cleanup - not just when the code path that created it also closed cleanly.
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
  const applicationName = `gateway-pg-test-${schemaName}`;
  let schemaCreated = false;
  let sql: postgres.Sql | undefined;

  const teardown = (): Promise<void> =>
    runAllSettling([
      async () => {
        if (sql !== undefined) await sql.end({ timeout: 5 });
      },
      async () => {
        if (schemaCreated) await dropSchema(url, schemaName);
      },
    ]);

  try {
    const admin = postgres(url, { max: 1 });
    try {
      await admin.unsafe(`CREATE SCHEMA "${schemaName}"`);
      schemaCreated = true;
    } finally {
      // Swallowed deliberately: this is a throwaway helper connection, and `schemaCreated`
      // (set above, before this runs) is what teardown actually keys off - a failure here
      // closing it must never mask the real error from the try block, nor skip the schema
      // drop that `schemaCreated` already correctly tracks as needed.
      await admin.end({ timeout: 5 }).catch(() => {});
    }

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
      close: teardown,
    };
  } catch (error) {
    await teardown().catch(() => {});
    throw error;
  }
}

/**
 * Polls `pg_stat_activity` while `stop.done` is false and returns the highest number of
 * distinct backends it ever observed simultaneously executing the reservation UPDATE, under
 * `applicationName` - i.e. genuinely overlapping `reserveAgentSpend` transactions FROM THIS
 * TEST'S OWN CONNECTION POOL specifically, not incidental activity from anything else that
 * might be running against the same shared Postgres server.
 *
 * This exists because "fire N promises with Promise.allSettled" only proves N requests were
 * ISSUED concurrently at the JS level (Codex review, round 1) - it does not, by itself, prove
 * the database ever actually ran overlapping transactions. Round 2 sharpened this further:
 * `state = 'active'` alone can't distinguish "mid-transaction-control/connection-setup" from
 * "actually executing the contended UPDATE", so this filters on `query` text matching the
 * reservation UPDATE statement (mcp/spend.ts) as well - not proof of row-level lock waiting
 * (that would need `pg_locks.granted = false`, which only fires once a lock is actually
 * contended, not merely "issued concurrently"), but direct, positive evidence that more than
 * one backend was mid-execution of the specific statement whose WHERE-clause correctness this
 * suite exists to exercise, which PGlite's single connection cannot produce at all. Sampling
 * at a fixed interval cannot GUARANTEE catching every overlap, but observing >=2 is real,
 * measured evidence - not an assumption about how promises happen to get scheduled.
 */
export async function observeMaxConcurrentActive(
  probe: postgres.Sql,
  applicationName: string,
  stop: { done: boolean },
): Promise<number> {
  let max = 0;
  while (!stop.done) {
    // Any of the four tables reserveAgentSpend's transaction actually touches (mcp/spend.ts
    // Steps 1-4) - narrow enough to exclude connection setup / bare BEGIN-COMMIT / SET
    // search_path (Codex review, round 2: those would also show `state = 'active'` with no
    // table-name filter at all), but wide enough to cover the full width of time each
    // transaction spends doing real work, not just its single narrowest statement (which was
    // too small a window to reliably sample - the earlier `agent_grant`-only filter observed
    // fewer overlaps than this).
    const rows = await probe<{ n: number }[]>`
      SELECT count(DISTINCT pid)::int AS n
      FROM pg_stat_activity
      WHERE state = 'active'
        AND application_name = ${applicationName}
        AND (
          query ILIKE '%agent_spend_reservation%'
          OR query ILIKE '%agent_principal_spend%'
          OR query ILIKE '%agent_grant%'
          OR query ILIKE '%mcp_session_spend%'
        )
    `;
    const n = rows[0]?.n ?? 0;
    if (n > max) max = n;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  return max;
}
