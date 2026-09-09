import { and, eq, sql } from "drizzle-orm";
import type { Hex } from "viem";
import {
  agentGrant,
  agentPrincipalSpend,
  agentSpendReservation,
  mcpSessionSpend,
} from "../db/schema";
import type { Db } from "../db/types";
import { readBindingDetails } from "../x402/settle";
import { McpToolError } from "./toolError";

/**
 * Spend reservation ledger (specs/mcp-auth-remediation-plan.md §4): every purchase reserves
 * against the daily principal cap, the grant's own budget, and the existing per-session cap
 * (mcp/session.ts, kept as a secondary brake) atomically, BEFORE any payment payload is
 * built or signed - this is what keeps 20 concurrent purchases against a small budget from
 * ever summing to more than the budget allows (agent_grant_budget_envelope_check /
 * agent_principal_spend_envelope_check, schema.ts, are the last-resort DB-level backstop if
 * this logic were ever wrong).
 *
 * Lock order (every function here, no exceptions): agent_spend_reservation ->
 * agent_principal_spend -> agent_grant -> mcp_session_spend. A fixed order across every
 * caller means no cycle is constructible, so no deadlock among these four tables.
 */
export type SpendDenialReason =
  | "daily_cap"
  | "grant_revoked"
  | "grant_expired"
  | "per_purchase_limit"
  | "grant_budget"
  | "session_cap";

export class SpendDeniedError extends McpToolError {
  constructor(
    readonly reason: SpendDenialReason,
    message: string,
  ) {
    super("SPEND_LIMIT_EXCEEDED", message);
  }
}

function utcDayOf(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export type AgentSpendReservation = {
  id: string;
  grantId: string;
  walletId: string;
};

export async function reserveAgentSpend(
  db: Db,
  input: {
    principalId: string;
    grantId: string;
    walletId: string;
    sessionKey: Hex;
    assetId: Hex;
    amountTinybar: bigint;
    dailyCapTinybar: bigint;
    sessionCapTinybar: bigint;
    now: Date;
  },
): Promise<AgentSpendReservation> {
  const utcDay = utcDayOf(input.now);
  const reservationId = crypto.randomUUID();
  const expiresAt = new Date(input.now.getTime() + 15 * 60 * 1000);

  return await db.transaction(async (tx) => {
    // Step 1: the reservation row itself - a fresh UUID, no contention with any other
    // reservation.
    await tx.insert(agentSpendReservation).values({
      id: reservationId,
      principalId: input.principalId,
      grantId: input.grantId,
      walletId: input.walletId,
      utcDay,
      mcpSessionKey: input.sessionKey,
      assetId: input.assetId,
      amountTinybar: input.amountTinybar,
      state: "reserved",
      expiresAt,
    });

    // A purchase larger than the entire daily cap must be denied even on a brand-new UTC day
    // (the row doesn't exist yet, so the INSERT branch below has no WHERE clause to catch this -
    // only onConflictDoUpdate's setWhere does).
    if (input.amountTinybar > input.dailyCapTinybar) {
      throw new SpendDeniedError(
        "daily_cap",
        `this purchase would exceed the ${input.dailyCapTinybar} tinybar daily cap for this principal`,
      );
    }

    // Step 2: principal x UTC-day cap, across every grant the principal holds. A single
    // `ON CONFLICT ... DO UPDATE` (not DO NOTHING) is required here: DO NOTHING does not
    // wait on a concurrent uncommitted inserter under READ COMMITTED, so two concurrent
    // purchases on a brand-new UTC day could both see zero rows and both be denied.
    const [dayRow] = await tx
      .insert(agentPrincipalSpend)
      .values({
        principalId: input.principalId,
        utcDay,
        dailyCapTinybar: input.dailyCapTinybar,
        reservedTinybar: input.amountTinybar,
        spentTinybar: 0n,
        updatedAt: input.now,
      })
      .onConflictDoUpdate({
        target: [agentPrincipalSpend.principalId, agentPrincipalSpend.utcDay],
        set: {
          reservedTinybar: sql`${agentPrincipalSpend.reservedTinybar} + ${input.amountTinybar.toString()}::numeric`,
          updatedAt: input.now,
        },
        setWhere: sql`${agentPrincipalSpend.reservedTinybar} + ${agentPrincipalSpend.spentTinybar} + ${input.amountTinybar.toString()}::numeric <= ${agentPrincipalSpend.dailyCapTinybar}`,
      })
      .returning({ principalId: agentPrincipalSpend.principalId });
    if (dayRow === undefined) {
      throw new SpendDeniedError(
        "daily_cap",
        `this purchase would exceed the ${input.dailyCapTinybar} tinybar daily cap for this principal`,
      );
    }

    // Step 3: grant budget + revocation/expiry, in one conditional UPDATE - the row lock
    // this takes is what serializes a reserve against a concurrent revoke.
    const [grantRow] = await tx
      .update(agentGrant)
      .set({
        reservedTinybar: sql`${agentGrant.reservedTinybar} + ${input.amountTinybar.toString()}::numeric`,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(agentGrant.id, input.grantId),
          eq(agentGrant.principalId, input.principalId),
          eq(agentGrant.walletId, input.walletId),
          eq(agentGrant.state, "active"),
          sql`${agentGrant.expiresAt} > ${input.now.toISOString()}::timestamptz`,
          sql`${input.amountTinybar.toString()}::numeric <= ${agentGrant.maxPerPurchaseTinybar}`,
          sql`${agentGrant.reservedTinybar} + ${agentGrant.spentTinybar} + ${input.amountTinybar.toString()}::numeric <= ${agentGrant.totalBudgetTinybar}`,
        ),
      )
      .returning({ id: agentGrant.id });
    if (grantRow === undefined) {
      // Re-select (still inside the transaction) to classify why, without re-deriving the
      // same predicate from scratch.
      const [current] = await tx
        .select()
        .from(agentGrant)
        .where(eq(agentGrant.id, input.grantId))
        .limit(1);
      if (current === undefined || current.state === "revoked") {
        throw new SpendDeniedError(
          "grant_revoked",
          "this delegation has been revoked",
        );
      }
      if (current.state === "expired" || current.expiresAt <= input.now) {
        throw new SpendDeniedError(
          "grant_expired",
          "this delegation has expired",
        );
      }
      if (input.amountTinybar > current.maxPerPurchaseTinybar) {
        throw new SpendDeniedError(
          "per_purchase_limit",
          `this purchase (${input.amountTinybar} tinybar) exceeds the per-purchase limit (${current.maxPerPurchaseTinybar} tinybar)`,
        );
      }
      throw new SpendDeniedError(
        "grant_budget",
        "this purchase would exceed the delegation's remaining budget",
      );
    }

    // Step 4: the existing per-session cap (mcp/session.ts R-9) as an additional, narrower
    // ceiling layered under the grant/daily caps - folded into the same transaction so a
    // partial reserve (grant debited but session cap exceeded) is impossible.
    await tx
      .insert(mcpSessionSpend)
      .values({ sessionKey: input.sessionKey, spentTinybar: 0n })
      .onConflictDoNothing();
    const [sessionRow] = await tx
      .update(mcpSessionSpend)
      .set({
        spentTinybar: sql`${mcpSessionSpend.spentTinybar} + ${input.amountTinybar.toString()}::numeric`,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(mcpSessionSpend.sessionKey, input.sessionKey),
          sql`${mcpSessionSpend.spentTinybar} + ${input.amountTinybar.toString()}::numeric <= ${input.sessionCapTinybar.toString()}::numeric`,
        ),
      )
      .returning({ sessionKey: mcpSessionSpend.sessionKey });
    if (sessionRow === undefined) {
      throw new SpendDeniedError(
        "session_cap",
        `this purchase would exceed the ${input.sessionCapTinybar} tinybar session cap`,
      );
    }

    return {
      id: reservationId,
      grantId: input.grantId,
      walletId: input.walletId,
    };
  });
}

/** Links a reservation to the X-PAYMENT payload's derived paymentId, the instant it exists -
 * this is what lets recovery classify an interrupted reservation via payment_binding. */
export async function linkReservationPayment(
  db: Db,
  reservationId: string,
  paymentId: Hex,
): Promise<void> {
  await db
    .update(agentSpendReservation)
    .set({ paymentId, updatedAt: new Date() })
    .where(
      and(
        eq(agentSpendReservation.id, reservationId),
        eq(agentSpendReservation.state, "reserved"),
        sql`${agentSpendReservation.paymentId} IS NULL`,
      ),
    );
}

type SettleOutcome = "commit" | "release" | "hold";

/**
 * The §4.6 decision table, from whatever payment_binding shows for the reservation's own
 * persisted paymentId (or "no payment was ever linked" when the caller never got far enough
 * to sign anything). `reservationExpiresAt` fences the two outcomes that mean "nothing has
 * moved yet, but a request may still be actively working on this paymentId right now"
 * (absent / pending+verify) so a concurrent caller can't free this reservation's budget for
 * reuse while the original payment attempt is still in flight and could still settle -
 * releasing early is only safe once the reservation's own 15-minute abandonment window
 * (reserveAgentSpend's `expiresAt`) has actually elapsed.
 */
async function classifyOutcome(
  db: Db,
  paymentId: Hex | null,
  reservationExpiresAt: Date,
  now: Date,
): Promise<SettleOutcome> {
  if (paymentId === null) return "release"; // no payload ever existed, nothing can be in flight
  const details = await readBindingDetails(db, paymentId);
  // paid_at is durable evidence value moved - honor it ahead of status/stage so a binding this
  // classification doesn't yet have a case for (or a future settle.ts state we haven't seen)
  // can never be misread as releasable.
  if (details.status !== "absent" && details.paidAt !== null) return "commit";
  if (details.status === "absent")
    return now >= reservationExpiresAt ? "release" : "hold";
  if (details.status === "failed") return "release"; // this specific attempt is definitively over
  if (details.status === "settled") return "commit";
  // status === "pending": stage verify is "claimed but nothing moved yet, possibly still being
  // worked on right now" -> fence the same as absent. settle/anchor -> hold (outcome unknown /
  // value already moving, respectively - never auto-release either).
  if (details.stage === "verify")
    return now >= reservationExpiresAt ? "release" : "hold";
  return "hold";
}

/**
 * Settles (or holds) a reservation exactly once: the `state = 'reserved'` CAS is what makes
 * this idempotent under a crash/retry - a reservation that already left `reserved` matches
 * zero rows and this is a no-op, returning the outcome that was actually recorded back then
 * (not a fresh reclassification, which could disagree with history if payment_binding moved
 * on since). The reservation's own persisted `paymentId` (set by linkReservationPayment) is
 * read and locked inside this same transaction - a caller can never talk this into releasing
 * budget for a payment that actually went on to settle by passing a stale/absent paymentId.
 */
export async function settleReservation(
  db: Db,
  reservationId: string,
  now: Date = new Date(),
): Promise<SettleOutcome> {
  return await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(agentSpendReservation)
      .where(eq(agentSpendReservation.id, reservationId))
      .for("update");
    if (existing === undefined) {
      throw new Error(
        `settleReservation: no such reservation ${reservationId}`,
      );
    }
    if (existing.state !== "reserved") {
      // already terminal: report what was actually decided, not a fresh (possibly stale) guess
      return existing.state === "committed" ? "commit" : "release";
    }

    const outcome = await classifyOutcome(
      tx,
      existing.paymentId,
      existing.expiresAt,
      now,
    );
    if (outcome === "hold") return outcome;

    const [reservation] = await tx
      .update(agentSpendReservation)
      .set(
        outcome === "commit"
          ? { state: "committed", settledAt: now, updatedAt: now }
          : { state: "released", releasedAt: now, updatedAt: now },
      )
      .where(
        and(
          eq(agentSpendReservation.id, reservationId),
          eq(agentSpendReservation.state, "reserved"),
        ),
      )
      .returning();
    if (reservation === undefined) return outcome; // lost a race with itself: no-op

    const amount = reservation.amountTinybar;
    if (outcome === "commit") {
      await tx
        .update(agentPrincipalSpend)
        .set({
          reservedTinybar: sql`${agentPrincipalSpend.reservedTinybar} - ${amount.toString()}::numeric`,
          spentTinybar: sql`${agentPrincipalSpend.spentTinybar} + ${amount.toString()}::numeric`,
          updatedAt: now,
        })
        .where(
          and(
            eq(agentPrincipalSpend.principalId, reservation.principalId),
            eq(agentPrincipalSpend.utcDay, reservation.utcDay),
          ),
        );
      await tx
        .update(agentGrant)
        .set({
          reservedTinybar: sql`${agentGrant.reservedTinybar} - ${amount.toString()}::numeric`,
          spentTinybar: sql`${agentGrant.spentTinybar} + ${amount.toString()}::numeric`,
          updatedAt: now,
        })
        .where(eq(agentGrant.id, reservation.grantId));
    } else {
      await tx
        .update(agentPrincipalSpend)
        .set({
          reservedTinybar: sql`greatest(${agentPrincipalSpend.reservedTinybar} - ${amount.toString()}::numeric, 0)`,
          updatedAt: now,
        })
        .where(
          and(
            eq(agentPrincipalSpend.principalId, reservation.principalId),
            eq(agentPrincipalSpend.utcDay, reservation.utcDay),
          ),
        );
      await tx
        .update(agentGrant)
        .set({
          reservedTinybar: sql`greatest(${agentGrant.reservedTinybar} - ${amount.toString()}::numeric, 0)`,
          updatedAt: now,
        })
        .where(eq(agentGrant.id, reservation.grantId));
      await tx
        .update(mcpSessionSpend)
        .set({
          spentTinybar: sql`greatest(${mcpSessionSpend.spentTinybar} - ${amount.toString()}::numeric, 0)`,
          updatedAt: now,
        })
        .where(eq(mcpSessionSpend.sessionKey, reservation.mcpSessionKey));
    }
    return outcome;
  });
}
