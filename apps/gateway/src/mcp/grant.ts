import { and, count, eq, sql } from "drizzle-orm";
import { agentGrant } from "../db/schema";
import type { AuthzDb } from "../db/types";
import type { Env } from "../env";
import { AppError } from "../errors";

/**
 * Delegation lifecycle (specs/mcp-auth-remediation-plan.md §1.7 / §6-8): an `agent_grant` row
 * is the single source of truth for whether a principal's AI agent may act at all. Every
 * MCP-tool-serving code path re-reads it fresh per call (`resolveDelegation`/`withGrantHeld`) -
 * never trusts a cached copy - so a revoke takes effect on the very next request, per
 * Constitution Principle II. `revision` is bumped on every state transition (never on the
 * reserved/spent counters spend.ts owns) specifically so a long-running operation like
 * decrypt_content can re-check it after the slow part to detect a revoke that landed
 * mid-flight (the "two-checkpoint" pattern, not yet wired up - tracked as a later phase).
 *
 * Every function here takes `AuthzDb` (db/types.ts), not plain `Db` - `agent_grant` reads must
 * never be served from Hyperdrive's query-result cache (Phase 5), so a caller must fetch
 * `c.get("authzDb")`, not `c.get("db")`, to even typecheck a call into this module.
 */
export type AgentGrant = typeof agentGrant.$inferSelect;

export async function resolveDelegation(
  db: AuthzDb,
  grantId: string,
): Promise<AgentGrant | undefined> {
  const [row] = await db
    .select()
    .from(agentGrant)
    .where(eq(agentGrant.id, grantId))
    .limit(1);
  return row;
}

/**
 * Reads the grant fresh by id and returns it only if usable, or throws the specific domain
 * error a caller (an MCP tool handler, an HTTP route) can surface as-is. Deliberately takes
 * `grantId`, not a `grant` object, so it is impossible to call this with a stale snapshot held
 * from an earlier read (Codex review, Phase 4: a `grant: AgentGrant` parameter let a caller
 * resolve once, hold the object across a revoke, and still pass validation against the
 * now-stale copy) - every call does its own DB read at the instant it runs.
 */
export async function assertGrantUsable(
  db: AuthzDb,
  grantId: string,
  now: Date,
): Promise<AgentGrant> {
  const grant = await resolveDelegation(db, grantId);
  if (grant === undefined) {
    throw new AppError("DELEGATION_NOT_FOUND", "no such delegation");
  }
  if (grant.state === "revoked") {
    throw new AppError("DELEGATION_REVOKED");
  }
  if (grant.state === "expired" || grant.expiresAt <= now) {
    throw new AppError("DELEGATION_EXPIRED");
  }
  return grant;
}

/** Assert-usable, then hand the live grant to `fn` - the shape every MCP tool handler that acts
 * on behalf of a delegation should use, so "read fresh, check usable, then act" can never be
 * split across call sites and drift apart. */
export async function withGrantHeld<T>(
  db: AuthzDb,
  grantId: string,
  now: Date,
  fn: (grant: AgentGrant) => Promise<T>,
): Promise<T> {
  const grant = await assertGrantUsable(db, grantId, now);
  return fn(grant);
}

export type CreateGrantInput = {
  principalId: string;
  walletId: string;
  clientId: string;
  scope: string;
  chainId: number;
  now: Date;
  totalBudgetTinybar?: bigint;
  maxPerPurchaseTinybar?: bigint;
  ttlSec?: number;
};

/**
 * Creates a new grant, falling back to the MCP_GRANT_DEFAULT_* env values (env.ts, Phase 3a)
 * for any budget/limit/TTL the caller doesn't specify. A second concurrent create for the same
 * (principalId, clientId) while one is already active is rejected by
 * agent_grant_live_principal_client_unique (schema.ts) - re-consent while a grant is already
 * active must revoke the old one first (revokeGrant), not call this again; this function does
 * not upsert, so that choice stays visible at the call site rather than silently overwriting an
 * existing budget/spend history.
 */
export async function createGrant(
  db: AuthzDb,
  env: Pick<
    Env,
    | "MCP_GRANT_DEFAULT_TOTAL_BUDGET_TINYBAR"
    | "MCP_GRANT_DEFAULT_MAX_PER_PURCHASE_TINYBAR"
    | "MCP_GRANT_DEFAULT_TTL_SEC"
  >,
  input: CreateGrantInput,
): Promise<AgentGrant> {
  const ttlSec = input.ttlSec ?? Number(env.MCP_GRANT_DEFAULT_TTL_SEC);
  const [row] = await db
    .insert(agentGrant)
    .values({
      id: crypto.randomUUID(),
      principalId: input.principalId,
      walletId: input.walletId,
      clientId: input.clientId,
      scope: input.scope,
      chainId: input.chainId,
      expiresAt: new Date(input.now.getTime() + ttlSec * 1000),
      totalBudgetTinybar:
        input.totalBudgetTinybar ??
        BigInt(env.MCP_GRANT_DEFAULT_TOTAL_BUDGET_TINYBAR),
      maxPerPurchaseTinybar:
        input.maxPerPurchaseTinybar ??
        BigInt(env.MCP_GRANT_DEFAULT_MAX_PER_PURCHASE_TINYBAR),
    })
    .returning();
  if (row === undefined) {
    // Unreachable under a successful INSERT ... RETURNING; narrows the type without an
    // assertion rather than actually being expected to happen.
    throw new AppError("DELEGATION_NOT_FOUND", "grant was not created");
  }
  return row;
}

/** Idempotent: revoking an already-non-active grant is a no-op (returns false), never a second
 * revocation or an error - a duplicate revoke request (retry, double-click) must not fail. */
export async function revokeGrant(
  db: AuthzDb,
  grantId: string,
  reason: string,
  now: Date,
): Promise<boolean> {
  const [row] = await db
    .update(agentGrant)
    .set({
      state: "revoked",
      revokedAt: now,
      revokedReason: reason,
      revision: sql`${agentGrant.revision} + 1`,
      updatedAt: now,
    })
    .where(and(eq(agentGrant.id, grantId), eq(agentGrant.state, "active")))
    .returning({ id: agentGrant.id });
  return row !== undefined;
}

/** Revokes every currently-active grant for a principal (the "revoke all AI access" admin
 * action) and returns the ids actually revoked - a principal with zero active grants returns
 * an empty array, not an error. */
export async function revokeAllDelegations(
  db: AuthzDb,
  principalId: string,
  reason: string,
  now: Date,
): Promise<string[]> {
  const rows = await db
    .update(agentGrant)
    .set({
      state: "revoked",
      revokedAt: now,
      revokedReason: reason,
      revision: sql`${agentGrant.revision} + 1`,
      updatedAt: now,
    })
    .where(
      and(
        eq(agentGrant.principalId, principalId),
        eq(agentGrant.state, "active"),
      ),
    )
    .returning({ id: agentGrant.id });
  return rows.map((r) => r.id);
}

/** Count of currently-active grants for a principal - used by admin/consent UI to show "N
 * connected apps" without loading full rows. */
export async function countActiveDelegations(
  db: AuthzDb,
  principalId: string,
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(agentGrant)
    .where(
      and(
        eq(agentGrant.principalId, principalId),
        eq(agentGrant.state, "active"),
      ),
    );
  return row?.n ?? 0;
}
