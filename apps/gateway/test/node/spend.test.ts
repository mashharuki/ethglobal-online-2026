import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import type { Hex } from "viem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  agentGrant,
  agentPrincipalSpend,
  agentWalletBinding,
  mcpSessionSpend,
  paymentBinding,
} from "../../src/db/schema";
import type { Db } from "../../src/db/types";
import {
  linkReservationPayment,
  reserveAgentSpend,
  SpendDeniedError,
  settleReservation,
} from "../../src/mcp/spend";
import { createTestDb } from "./helpers";

/**
 * Integration tests against a real PGlite Postgres for the reserve/commit/release ledger
 * (specs/mcp-auth-remediation-plan.md §4). PGlite is single-connection, so true concurrent
 * contention (the "20 parallel purchases" scenario) is NOT exercised here - only that the
 * sequential logic (each conditional UPDATE's WHERE clause) is correct. A real-Postgres
 * concurrency test is tracked as follow-up work (Phase 11 of the remediation plan).
 */
const NOW = new Date("2026-09-09T12:00:00Z");
const SESSION_KEY = `0x${"aa".repeat(32)}` as Hex;
const ASSET_ID = `0x${"bb".repeat(32)}` as Hex;

let db: Db;
let client: PGlite;

async function seedGrant(overrides: {
  totalBudgetTinybar?: bigint;
  maxPerPurchaseTinybar?: bigint;
  state?: "active" | "revoked" | "expired";
  expiresAt?: Date;
  // a principal has at most one live agentWalletBinding (partial unique index on
  // (principalId, purpose) WHERE provisioningState <> 'retired') - tests that seed a second
  // grant for the same principal must reuse the first grant's walletId rather than creating
  // a second binding.
  walletId?: string;
  clientId?: string;
}) {
  const walletId = overrides.walletId ?? crypto.randomUUID();
  const grantId = crypto.randomUUID();
  if (overrides.walletId === undefined) {
    await db.insert(agentWalletBinding).values({
      id: walletId,
      principalId: "did:privy:spend-test",
      purpose: "mcp-agent",
      chainType: "ethereum",
      chainId: 296,
      delegationShape: "additional-signer",
      externalId: `aiwallet-spend-test-${walletId}`,
      provisioningKey: `aiwallet:v1:spend-test:${walletId}`,
      provisioningState: "active",
      privyWalletId: `privy-${walletId}`,
      address: `0x${"11".repeat(20)}` as Hex,
      signerQuorumId: "quorum-1",
      signerState: "attached",
      ownerVerifiedAt: NOW,
    });
  }
  await db.insert(agentGrant).values({
    id: grantId,
    principalId: "did:privy:spend-test",
    walletId,
    clientId: overrides.clientId ?? "client-1",
    scope: "assets:read access:buy",
    chainId: 296,
    expiresAt: overrides.expiresAt ?? new Date(NOW.getTime() + 3_600_000),
    totalBudgetTinybar: overrides.totalBudgetTinybar ?? 10_000_000n,
    maxPerPurchaseTinybar: overrides.maxPerPurchaseTinybar ?? 5_000_000n,
    state: overrides.state ?? "active",
    revokedAt: overrides.state === "revoked" ? NOW : undefined,
  });
  return { grantId, walletId };
}

beforeEach(async () => {
  ({ db, client } = await createTestDb());
});

afterEach(async () => {
  await client.close();
});

describe("reserveAgentSpend", () => {
  it("should reserve against the daily/grant/session ledgers atomically", async () => {
    const { grantId, walletId } = await seedGrant({});
    const reservation = await reserveAgentSpend(db, {
      principalId: "did:privy:spend-test",
      grantId,
      walletId,
      sessionKey: SESSION_KEY,
      assetId: ASSET_ID,
      amountTinybar: 2_000_000n,
      dailyCapTinybar: 100_000_000n,
      sessionCapTinybar: 2_000_000_000n,
      now: NOW,
    });
    expect(reservation.grantId).toBe(grantId);

    const [dayRow] = await db
      .select()
      .from(agentPrincipalSpend)
      .where(eq(agentPrincipalSpend.principalId, "did:privy:spend-test"));
    expect(dayRow?.reservedTinybar).toBe(2_000_000n);

    const [grantRow] = await db
      .select()
      .from(agentGrant)
      .where(eq(agentGrant.id, grantId));
    expect(grantRow?.reservedTinybar).toBe(2_000_000n);

    const [sessionRow] = await db
      .select()
      .from(mcpSessionSpend)
      .where(eq(mcpSessionSpend.sessionKey, SESSION_KEY));
    expect(sessionRow?.spentTinybar).toBe(2_000_000n);
  });

  it("should deny with SpendDeniedError(grant_budget) without partially reserving any ledger", async () => {
    const { grantId, walletId } = await seedGrant({
      totalBudgetTinybar: 1_000_000n,
      maxPerPurchaseTinybar: 1_000_000n,
    });
    await expect(
      reserveAgentSpend(db, {
        principalId: "did:privy:spend-test",
        grantId,
        walletId,
        sessionKey: SESSION_KEY,
        assetId: ASSET_ID,
        amountTinybar: 2_000_000n, // exceeds both maxPerPurchase and totalBudget
        dailyCapTinybar: 100_000_000n,
        sessionCapTinybar: 2_000_000_000n,
        now: NOW,
      }),
    ).rejects.toThrow(SpendDeniedError);

    // the transaction must have rolled back completely - no ledger shows a partial reserve
    const [dayRow] = await db
      .select()
      .from(agentPrincipalSpend)
      .where(eq(agentPrincipalSpend.principalId, "did:privy:spend-test"));
    expect(dayRow).toBeUndefined();
    const [grantRow] = await db
      .select()
      .from(agentGrant)
      .where(eq(agentGrant.id, grantId));
    expect(grantRow?.reservedTinybar).toBe(0n);
  });

  it("should deny with SpendDeniedError(grant_revoked) for a revoked grant", async () => {
    const { grantId, walletId } = await seedGrant({ state: "revoked" });
    const error = await reserveAgentSpend(db, {
      principalId: "did:privy:spend-test",
      grantId,
      walletId,
      sessionKey: SESSION_KEY,
      assetId: ASSET_ID,
      amountTinybar: 1_000_000n,
      dailyCapTinybar: 100_000_000n,
      sessionCapTinybar: 2_000_000_000n,
      now: NOW,
    }).catch((e) => e as SpendDeniedError);
    expect(error).toBeInstanceOf(SpendDeniedError);
    expect((error as SpendDeniedError).reason).toBe("grant_revoked");
  });

  it("should deny with SpendDeniedError(grant_expired) for an expired grant", async () => {
    const { grantId, walletId } = await seedGrant({
      expiresAt: new Date(NOW.getTime() - 1000),
    });
    const error = await reserveAgentSpend(db, {
      principalId: "did:privy:spend-test",
      grantId,
      walletId,
      sessionKey: SESSION_KEY,
      assetId: ASSET_ID,
      amountTinybar: 1_000_000n,
      dailyCapTinybar: 100_000_000n,
      sessionCapTinybar: 2_000_000_000n,
      now: NOW,
    }).catch((e) => e as SpendDeniedError);
    expect(error).toBeInstanceOf(SpendDeniedError);
    expect((error as SpendDeniedError).reason).toBe("grant_expired");
  });

  it("should deny with SpendDeniedError(daily_cap) once the principal's daily cap is exhausted, even across two different grants", async () => {
    const first = await seedGrant({});
    await reserveAgentSpend(db, {
      principalId: "did:privy:spend-test",
      grantId: first.grantId,
      walletId: first.walletId,
      sessionKey: SESSION_KEY,
      assetId: ASSET_ID,
      amountTinybar: 5_000_000n,
      dailyCapTinybar: 6_000_000n,
      sessionCapTinybar: 2_000_000_000n,
      now: NOW,
    });
    // a second grant for the same principal - the daily cap must still bind ACROSS grants
    // (reuse the first grant's walletId: a principal has at most one live wallet binding,
    // and use a distinct clientId: a principal has at most one live grant per client)
    const second = await seedGrant({
      walletId: first.walletId,
      clientId: "client-2",
    });
    const error = await reserveAgentSpend(db, {
      principalId: "did:privy:spend-test",
      grantId: second.grantId,
      walletId: second.walletId,
      sessionKey: `0x${"cc".repeat(32)}` as Hex,
      assetId: ASSET_ID,
      amountTinybar: 2_000_000n, // 5M + 2M > 6M cap
      dailyCapTinybar: 6_000_000n,
      sessionCapTinybar: 2_000_000_000n,
      now: NOW,
    }).catch((e) => e as SpendDeniedError);
    expect(error).toBeInstanceOf(SpendDeniedError);
    expect((error as SpendDeniedError).reason).toBe("daily_cap");
  });

  it("should deny with SpendDeniedError(daily_cap) for the very FIRST purchase of a brand-new UTC day if it alone exceeds the daily cap", async () => {
    // Regression test (Codex review): the very first agent_principal_spend row for a
    // (principal, day) is created by a plain INSERT, not the ON CONFLICT DO UPDATE branch -
    // onConflictDoUpdate's setWhere cap check never runs on that path, so without an explicit
    // guard a single oversized purchase could sail through on a fresh day.
    const { grantId, walletId } = await seedGrant({
      totalBudgetTinybar: 100_000_000n,
      maxPerPurchaseTinybar: 100_000_000n,
    });
    const error = await reserveAgentSpend(db, {
      principalId: "did:privy:spend-test",
      grantId,
      walletId,
      sessionKey: SESSION_KEY,
      assetId: ASSET_ID,
      amountTinybar: 10_000_000n, // exceeds dailyCapTinybar below, but not grant/session caps
      dailyCapTinybar: 6_000_000n,
      sessionCapTinybar: 2_000_000_000n,
      now: NOW,
    }).catch((e) => e as SpendDeniedError);
    expect(error).toBeInstanceOf(SpendDeniedError);
    expect((error as SpendDeniedError).reason).toBe("daily_cap");

    // and no ledger shows a partial reserve from the aborted transaction
    const [dayRow] = await db
      .select()
      .from(agentPrincipalSpend)
      .where(eq(agentPrincipalSpend.principalId, "did:privy:spend-test"));
    expect(dayRow).toBeUndefined();
  });

  it("should deny with SpendDeniedError(session_cap) even when the grant/daily caps have room", async () => {
    const { grantId, walletId } = await seedGrant({});
    const error = await reserveAgentSpend(db, {
      principalId: "did:privy:spend-test",
      grantId,
      walletId,
      sessionKey: SESSION_KEY,
      assetId: ASSET_ID,
      amountTinybar: 1_000_000n,
      dailyCapTinybar: 100_000_000n,
      sessionCapTinybar: 500_000n, // narrower than the amount
      now: NOW,
    }).catch((e) => e as SpendDeniedError);
    expect(error).toBeInstanceOf(SpendDeniedError);
    expect((error as SpendDeniedError).reason).toBe("session_cap");
  });
});

// Past the 15-minute reservation abandonment window (reserveAgentSpend's `expiresAt` is
// NOW + 15min) - settling at this instant is never fenced back to "hold" by classifyOutcome.
const AFTER_EXPIRY = new Date(NOW.getTime() + 20 * 60 * 1000);

describe("settleReservation", () => {
  it("should release (reserved -> freed) when no payment was ever linked", async () => {
    const { grantId, walletId } = await seedGrant({});
    const reservation = await reserveAgentSpend(db, {
      principalId: "did:privy:spend-test",
      grantId,
      walletId,
      sessionKey: SESSION_KEY,
      assetId: ASSET_ID,
      amountTinybar: 2_000_000n,
      dailyCapTinybar: 100_000_000n,
      sessionCapTinybar: 2_000_000_000n,
      now: NOW,
    });
    // no paymentId was ever linked - safe to release immediately regardless of `now`, since
    // nothing could possibly still be in flight for a payload that was never built.
    const outcome = await settleReservation(db, reservation.id, NOW);
    expect(outcome).toBe("release");

    const [grantRow] = await db
      .select()
      .from(agentGrant)
      .where(eq(agentGrant.id, grantId));
    expect(grantRow?.reservedTinybar).toBe(0n);
    expect(grantRow?.spentTinybar).toBe(0n);
  });

  it("should commit (reserved -> spent) when the linked payment settled, moving the ledgers by exactly the reserved amount", async () => {
    const { grantId, walletId } = await seedGrant({});
    const reservation = await reserveAgentSpend(db, {
      principalId: "did:privy:spend-test",
      grantId,
      walletId,
      sessionKey: SESSION_KEY,
      assetId: ASSET_ID,
      amountTinybar: 2_000_000n,
      dailyCapTinybar: 100_000_000n,
      sessionCapTinybar: 2_000_000_000n,
      now: NOW,
    });
    const paymentId = `0x${"ee".repeat(32)}` as Hex;
    await linkReservationPayment(db, reservation.id, paymentId);
    await db.insert(paymentBinding).values({
      paymentId,
      purchaseRequestHash: `0x${"ff".repeat(32)}` as Hex,
      amount: 2_000_000n,
      status: "settled",
      stage: "done",
      paidAt: NOW,
    });

    const outcome = await settleReservation(db, reservation.id, NOW);
    expect(outcome).toBe("commit");

    const [grantRow] = await db
      .select()
      .from(agentGrant)
      .where(eq(agentGrant.id, grantId));
    expect(grantRow?.reservedTinybar).toBe(0n);
    expect(grantRow?.spentTinybar).toBe(2_000_000n);

    const [dayRow] = await db
      .select()
      .from(agentPrincipalSpend)
      .where(eq(agentPrincipalSpend.principalId, "did:privy:spend-test"));
    expect(dayRow?.reservedTinybar).toBe(0n);
    expect(dayRow?.spentTinybar).toBe(2_000_000n);
  });

  it("should hold (never release or commit) while the linked payment is still absent and the reservation has not yet expired", async () => {
    const { grantId, walletId } = await seedGrant({});
    const reservation = await reserveAgentSpend(db, {
      principalId: "did:privy:spend-test",
      grantId,
      walletId,
      sessionKey: SESSION_KEY,
      assetId: ASSET_ID,
      amountTinybar: 1_000_000n,
      dailyCapTinybar: 100_000_000n,
      sessionCapTinybar: 2_000_000_000n,
      now: NOW,
    });
    const paymentId = `0x${"dd".repeat(32)}` as Hex;
    await linkReservationPayment(db, reservation.id, paymentId);
    // no payment_binding row for this id yet ("absent") - a request may still be actively
    // working on it right now, so settling before the reservation's own expiry must hold,
    // never release (which would free this budget for a concurrent purchase to reuse while
    // the original payment could still go on to settle).
    const outcome = await settleReservation(db, reservation.id, NOW);
    expect(outcome).toBe("hold");

    const [grantRow] = await db
      .select()
      .from(agentGrant)
      .where(eq(agentGrant.id, grantId));
    expect(grantRow?.reservedTinybar).toBe(1_000_000n); // still reserved, not released
  });

  it("should release an absent-payment reservation once its own abandonment window has elapsed", async () => {
    const { grantId, walletId } = await seedGrant({});
    const reservation = await reserveAgentSpend(db, {
      principalId: "did:privy:spend-test",
      grantId,
      walletId,
      sessionKey: SESSION_KEY,
      assetId: ASSET_ID,
      amountTinybar: 1_000_000n,
      dailyCapTinybar: 100_000_000n,
      sessionCapTinybar: 2_000_000_000n,
      now: NOW,
    });
    const paymentId = `0x${"dd".repeat(32)}` as Hex;
    await linkReservationPayment(db, reservation.id, paymentId);
    const outcome = await settleReservation(db, reservation.id, AFTER_EXPIRY);
    expect(outcome).toBe("release");

    const [grantRow] = await db
      .select()
      .from(agentGrant)
      .where(eq(agentGrant.id, grantId));
    expect(grantRow?.reservedTinybar).toBe(0n);
  });

  it("should never release a reservation whose payment_binding shows paid_at set, even if status/stage alone would otherwise say release", async () => {
    // Defensive hardening (Codex review): paid_at is durable evidence value moved, so it must
    // be honored ahead of status/stage even for a binding shape that shouldn't occur given
    // x402/settle.ts's own invariants today (paid_at is only ever set together with stage
    // "anchor"/"settled") - a future settle.ts change must not silently start releasing
    // budget for payments that actually went through.
    const { grantId, walletId } = await seedGrant({});
    const reservation = await reserveAgentSpend(db, {
      principalId: "did:privy:spend-test",
      grantId,
      walletId,
      sessionKey: SESSION_KEY,
      assetId: ASSET_ID,
      amountTinybar: 1_000_000n,
      dailyCapTinybar: 100_000_000n,
      sessionCapTinybar: 2_000_000_000n,
      now: NOW,
    });
    const paymentId = `0x${"12".repeat(32)}` as Hex;
    await linkReservationPayment(db, reservation.id, paymentId);
    await db.insert(paymentBinding).values({
      paymentId,
      purchaseRequestHash: `0x${"34".repeat(32)}` as Hex,
      amount: 1_000_000n,
      status: "failed", // would normally mean "release" (definitive rejection)...
      stage: "verify",
      paidAt: NOW, // ...but paid_at set must override that to "commit"
    });

    const outcome = await settleReservation(db, reservation.id, AFTER_EXPIRY);
    expect(outcome).toBe("commit");
  });

  it("should be idempotent: settling an already-terminal reservation twice returns the originally-recorded outcome and does not double-adjust the ledgers", async () => {
    const { grantId, walletId } = await seedGrant({});
    const reservation = await reserveAgentSpend(db, {
      principalId: "did:privy:spend-test",
      grantId,
      walletId,
      sessionKey: SESSION_KEY,
      assetId: ASSET_ID,
      amountTinybar: 2_000_000n,
      dailyCapTinybar: 100_000_000n,
      sessionCapTinybar: 2_000_000_000n,
      now: NOW,
    });
    const first = await settleReservation(db, reservation.id, NOW);
    const second = await settleReservation(db, reservation.id, NOW);
    expect(first).toBe("release");
    expect(second).toBe("release"); // read back from the row's terminal state, not reclassified

    const [grantRow] = await db
      .select()
      .from(agentGrant)
      .where(eq(agentGrant.id, grantId));
    expect(grantRow?.reservedTinybar).toBe(0n); // not negative from a double-release
  });

  it("should throw for an unknown reservation id", async () => {
    await expect(
      settleReservation(db, crypto.randomUUID(), NOW),
    ).rejects.toThrow();
  });
});
