import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type * as schema from "./schema";

/**
 * Driver-agnostic database handle: postgres.js via Hyperdrive in the Worker
 * (db/client.ts), PGlite in the node test suite. Modules that only need queries
 * (audit, nonce, receipt lock) depend on this type, never on a driver.
 */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

/** Postgres SQLSTATE codes the gateway branches on. */
const PG_UNIQUE_VIOLATION = "23505";
export const PG_CHECK_VIOLATION = "23514";

export function pgErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const direct = (error as { code?: unknown }).code;
  if (typeof direct === "string") return direct;
  const cause = (error as { cause?: unknown }).cause;
  return cause === undefined ? undefined : pgErrorCode(cause);
}

export function isUniqueViolation(error: unknown): boolean {
  return pgErrorCode(error) === PG_UNIQUE_VIOLATION;
}
