import { eq } from "drizzle-orm";
import type { Hex } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentGrant, agentWalletBinding } from "../../src/db/schema";
import type { Db } from "../../src/db/types";
import { reserveAgentSpend, SpendDeniedError } from "../../src/mcp/spend";
import { connectPgTestDb, type PgTestDb } from "./helpers";

/**
 * The "20 concurrent purchases" scenario a PGlite (single-connection) suite cannot exercise
 * (test/node/spend.test.ts's own header names this exact gap): 20 real, concurrent Postgres
 * transactions all racing to reserve against ONE grant whose budget only covers a fraction of
 * them. `reserveAgentSpend`'s conditional `UPDATE ... WHERE reserved + spent + amount <=
 * total_budget` (mcp/spend.ts) is what must serialize this correctly - `describe.skipIf`
 * without `DATABASE_URL_PG` (REQUIRE_PG=1 in CI turns that into a hard failure instead, per
 * helpers.ts) so this never silently reports a green suite for logic it never ran against a
 * real server.
 */
const NOW = new Date("2026-09-09T12:00:00Z");
const PRINCIPAL_ID = "did:privy:pg-concurrency-test";
const ASSET_ID = `0x${"cc".repeat(32)}` as Hex;
const AMOUNT_TINYBAR = 1_000_000n;
const CONCURRENCY = 20;
const CAPACITY = 6; // exactly this many of the CONCURRENCY attempts can fit in the budget

// Decided at module load, BEFORE beforeAll ever runs (describe.skipIf below reads this
// synchronously) - matching apps/agent/test/autonomous.spec.ts's own "check env presence at
// module scope, not inside a hook" pattern. REQUIRE_PG=1 with no URL is deliberately NOT a
// skip: `ready` stays true so the suite runs, and connectPgTestDb() throws inside beforeAll.
const ready =
  (process.env.DATABASE_URL_PG ?? "") !== "" || process.env.REQUIRE_PG === "1";
if (!ready) {
  console.warn(
    "[pg] DATABASE_URL_PG not set: the real-Postgres concurrency suite is SKIPPED (not verified).",
  );
}

let pg: PgTestDb | undefined;
let db: Db;

beforeAll(async () => {
  pg = await connectPgTestDb();
  if (pg === undefined) return;
  db = pg.db;
});

afterAll(async () => {
  await pg?.close();
});

async function seedGrant(): Promise<{ grantId: string; walletId: string }> {
  const walletId = crypto.randomUUID();
  const grantId = crypto.randomUUID();
  await db.insert(agentWalletBinding).values({
    id: walletId,
    principalId: PRINCIPAL_ID,
    purpose: "mcp-agent",
    chainType: "ethereum",
    chainId: 296,
    delegationShape: "additional-signer",
    externalId: `aiwallet-pg-concurrency-${walletId}`,
    provisioningKey: `aiwallet:v1:pg-concurrency:${walletId}`,
    provisioningState: "active",
    privyWalletId: `privy-${walletId}`,
    address: `0x${"22".repeat(20)}` as Hex,
    signerQuorumId: "quorum-1",
    signerState: "attached",
    ownerVerifiedAt: NOW,
  });
  await db.insert(agentGrant).values({
    id: grantId,
    principalId: PRINCIPAL_ID,
    walletId,
    clientId: "client-pg-concurrency",
    scope: "assets:read access:buy",
    chainId: 296,
    expiresAt: new Date(NOW.getTime() + 3_600_000),
    totalBudgetTinybar: AMOUNT_TINYBAR * BigInt(CAPACITY),
    maxPerPurchaseTinybar: AMOUNT_TINYBAR,
    state: "active",
  });
  return { grantId, walletId };
}

describe.skipIf(!ready)(
  "reserveAgentSpend under real concurrent load (Phase 11)",
  () => {
    it(`should let exactly ${CAPACITY} of ${CONCURRENCY} concurrent reservations succeed, never over-reserving the grant budget`, async () => {
      const { grantId, walletId } = await seedGrant();

      const attempts = Array.from({ length: CONCURRENCY }, (_, i) =>
        reserveAgentSpend(db, {
          principalId: PRINCIPAL_ID,
          grantId,
          walletId,
          // a distinct session per attempt: the per-session cap (mcp/session.ts) is a
          // separate, narrower brake this test isn't exercising - only the grant budget
          // should be the binding constraint here.
          sessionKey:
            `0x${i.toString(16).padStart(2, "0")}${"00".repeat(31)}` as Hex,
          assetId: ASSET_ID,
          amountTinybar: AMOUNT_TINYBAR,
          dailyCapTinybar: AMOUNT_TINYBAR * BigInt(CONCURRENCY * 10),
          sessionCapTinybar: AMOUNT_TINYBAR * BigInt(CONCURRENCY * 10),
          now: NOW,
        }),
      );

      const results = await Promise.allSettled(attempts);

      const succeeded = results.filter((r) => r.status === "fulfilled");
      const failed = results.filter(
        (r): r is PromiseRejectedResult => r.status === "rejected",
      );
      expect(succeeded).toHaveLength(CAPACITY);
      expect(failed).toHaveLength(CONCURRENCY - CAPACITY);
      // every denial must be the application-level SpendDeniedError(grant_budget) - never a
      // raw Postgres error (a serialization failure, a CHECK-constraint violation reaching
      // the caller, a deadlock) escaping past reserveAgentSpend's own transaction.
      for (const r of failed) {
        expect(r.reason).toBeInstanceOf(SpendDeniedError);
        expect((r.reason as SpendDeniedError).reason).toBe("grant_budget");
      }

      const [grantRow] = await db
        .select()
        .from(agentGrant)
        .where(eq(agentGrant.id, grantId));
      // deterministic, not just "did not exceed": exactly CAPACITY reservations landed, no
      // fewer (a correct implementation should never leave headroom unused) and no more
      // (agent_grant_budget_envelope_check, schema.ts, is the last-resort backstop for this
      // never happening at all).
      expect(grantRow?.reservedTinybar).toBe(AMOUNT_TINYBAR * BigInt(CAPACITY));
      expect(
        (grantRow?.reservedTinybar ?? 0n) + (grantRow?.spentTinybar ?? 0n),
      ).toBeLessThanOrEqual(grantRow?.totalBudgetTinybar ?? 0n);
    }, 30_000);
  },
);
