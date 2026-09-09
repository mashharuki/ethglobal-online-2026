import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type * as schema from "./schema";

/**
 * Driver-agnostic database handle: postgres.js via Hyperdrive in the Worker
 * (db/client.ts), PGlite in the node test suite. Modules that only need queries
 * (audit, nonce, receipt lock) depend on this type, never on a driver.
 */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

/**
 * A `Db` known to be backed by the cache-disabled HYPERDRIVE_AUTHZ binding (Codex review,
 * Phase 5: `Db` alone let a caller pass the regular cached handle into an
 * authorization-critical function and have it typecheck fine, since both handles are
 * structurally identical - test/node/authzHandle.test.ts's grep-based check catches the exact
 * shapes it knows to look for, but a renamed/aliased variable slips past it). The brand exists
 * only at the type level (`createAuthzDb`, db/client.ts, is the one place that casts to it) -
 * there is nothing to check at runtime, so a function that takes `AuthzDb` is trusting its
 * caller passed the right handle, the same way `Db` always has. What changes is that passing
 * the wrong handle is now a compile error at the call site instead of invisible to both the
 * type checker and (if the exact call shape doesn't match) the grep lint.
 */
declare const authzDbBrand: unique symbol;
export type AuthzDb = Db & { readonly [authzDbBrand]: true };

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
