import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentGrant, agentWalletBinding } from "../../src/db/schema";
import type { Db } from "../../src/db/types";
import { AppError } from "../../src/errors";
import {
  assertGrantUsable,
  countActiveDelegations,
  createGrant,
  resolveDelegation,
  revokeAllDelegations,
  revokeGrant,
  withGrantHeld,
} from "../../src/mcp/grant";
import { createTestDb } from "./helpers";

const NOW = new Date("2026-09-09T12:00:00Z");
const GRANT_ENV = {
  MCP_GRANT_DEFAULT_TOTAL_BUDGET_TINYBAR: "10000000",
  MCP_GRANT_DEFAULT_MAX_PER_PURCHASE_TINYBAR: "1000000",
  MCP_GRANT_DEFAULT_TTL_SEC: "3600",
};

let db: Db;
let client: PGlite;

let nextWalletAddressSeed = 1;

async function seedWallet(principalId: string): Promise<string> {
  const walletId = crypto.randomUUID();
  const addressSeed = nextWalletAddressSeed++;
  await db.insert(agentWalletBinding).values({
    id: walletId,
    principalId,
    purpose: "mcp-agent",
    chainType: "ethereum",
    chainId: 296,
    delegationShape: "additional-signer",
    externalId: `aiwallet-grant-test-${walletId}`,
    provisioningKey: `aiwallet:v1:grant-test:${walletId}`,
    provisioningState: "active",
    privyWalletId: `privy-${walletId}`,
    address: `0x${String(addressSeed).padStart(40, "0")}`,
    signerQuorumId: "quorum-1",
    signerState: "attached",
    ownerVerifiedAt: NOW,
  });
  return walletId;
}

beforeEach(async () => {
  ({ db, client } = await createTestDb());
});

afterEach(async () => {
  await client.close();
});

describe("createGrant", () => {
  it("should create an active grant, applying env defaults for budget/limit/ttl", async () => {
    const walletId = await seedWallet("did:privy:grant-test");
    const grant = await createGrant(db, GRANT_ENV, {
      principalId: "did:privy:grant-test",
      walletId,
      clientId: "client-1",
      scope: "assets:read access:buy",
      chainId: 296,
      now: NOW,
    });
    expect(grant.state).toBe("active");
    expect(grant.totalBudgetTinybar).toBe(10_000_000n);
    expect(grant.maxPerPurchaseTinybar).toBe(1_000_000n);
    expect(grant.expiresAt.getTime()).toBe(NOW.getTime() + 3600 * 1000);
    expect(grant.reservedTinybar).toBe(0n);
    expect(grant.spentTinybar).toBe(0n);
    expect(grant.revision).toBe(0n);
  });

  it("should reject a second active grant for the same (principalId, clientId) while one is already active", async () => {
    const walletId = await seedWallet("did:privy:grant-dup");
    await createGrant(db, GRANT_ENV, {
      principalId: "did:privy:grant-dup",
      walletId,
      clientId: "client-1",
      scope: "assets:read",
      chainId: 296,
      now: NOW,
    });
    await expect(
      createGrant(db, GRANT_ENV, {
        principalId: "did:privy:grant-dup",
        walletId,
        clientId: "client-1",
        scope: "assets:read",
        chainId: 296,
        now: NOW,
      }),
    ).rejects.toThrow();
  });

  it("should honor explicit overrides instead of env defaults", async () => {
    const walletId = await seedWallet("did:privy:grant-override");
    const grant = await createGrant(db, GRANT_ENV, {
      principalId: "did:privy:grant-override",
      walletId,
      clientId: "client-1",
      scope: "assets:read",
      chainId: 296,
      now: NOW,
      totalBudgetTinybar: 500_000_000n,
      maxPerPurchaseTinybar: 50_000_000n,
      ttlSec: 60,
    });
    expect(grant.totalBudgetTinybar).toBe(500_000_000n);
    expect(grant.maxPerPurchaseTinybar).toBe(50_000_000n);
    expect(grant.expiresAt.getTime()).toBe(NOW.getTime() + 60 * 1000);
  });
});

describe("resolveDelegation / assertGrantUsable", () => {
  it("should resolve an existing grant by id", async () => {
    const walletId = await seedWallet("did:privy:resolve-test");
    const created = await createGrant(db, GRANT_ENV, {
      principalId: "did:privy:resolve-test",
      walletId,
      clientId: "client-1",
      scope: "assets:read",
      chainId: 296,
      now: NOW,
    });
    const resolved = await resolveDelegation(db, created.id);
    expect(resolved?.id).toBe(created.id);
  });

  it("should return undefined for an unknown grant id", async () => {
    const resolved = await resolveDelegation(db, crypto.randomUUID());
    expect(resolved).toBeUndefined();
  });

  it("should throw AppError(DELEGATION_NOT_FOUND) for an unknown grant id", async () => {
    await expect(
      assertGrantUsable(db, crypto.randomUUID(), NOW),
    ).rejects.toThrow(AppError);
    try {
      await assertGrantUsable(db, crypto.randomUUID(), NOW);
    } catch (e) {
      expect((e as AppError).code).toBe("DELEGATION_NOT_FOUND");
    }
  });

  it("should throw AppError(DELEGATION_REVOKED) for a revoked grant", async () => {
    const walletId = await seedWallet("did:privy:revoked-test");
    const created = await createGrant(db, GRANT_ENV, {
      principalId: "did:privy:revoked-test",
      walletId,
      clientId: "client-1",
      scope: "assets:read",
      chainId: 296,
      now: NOW,
    });
    await revokeGrant(db, created.id, "user requested", NOW);
    await expect(assertGrantUsable(db, created.id, NOW)).rejects.toThrow(
      AppError,
    );
    try {
      await assertGrantUsable(db, created.id, NOW);
    } catch (e) {
      expect((e as AppError).code).toBe("DELEGATION_REVOKED");
    }
  });

  it("should throw AppError(DELEGATION_EXPIRED) once now passes expiresAt, even though state is still 'active'", async () => {
    const walletId = await seedWallet("did:privy:expired-test");
    const created = await createGrant(db, GRANT_ENV, {
      principalId: "did:privy:expired-test",
      walletId,
      clientId: "client-1",
      scope: "assets:read",
      chainId: 296,
      now: NOW,
      ttlSec: 60,
    });
    const afterExpiry = new Date(NOW.getTime() + 61 * 1000);
    await expect(
      assertGrantUsable(db, created.id, afterExpiry),
    ).rejects.toThrow(AppError);
    try {
      await assertGrantUsable(db, created.id, afterExpiry);
    } catch (e) {
      expect((e as AppError).code).toBe("DELEGATION_EXPIRED");
    }
  });

  it("should require a fresh DB read rather than trusting a stale snapshot: a grant object held before a revoke is never accepted", async () => {
    // Regression test (Codex review): assertGrantUsable previously took a `grant: AgentGrant`
    // snapshot parameter, so a caller could resolve once, hold the object across a revoke
    // that happened elsewhere, and still pass validation against the now-stale copy. Taking
    // `grantId` and reading fresh internally makes this impossible - there is no snapshot
    // parameter to smuggle a stale object through any more.
    const walletId = await seedWallet("did:privy:stale-snapshot");
    const created = await createGrant(db, GRANT_ENV, {
      principalId: "did:privy:stale-snapshot",
      walletId,
      clientId: "client-1",
      scope: "assets:read",
      chainId: 296,
      now: NOW,
    });
    const snapshotBeforeRevoke = await resolveDelegation(db, created.id);
    expect(snapshotBeforeRevoke?.state).toBe("active"); // the stale snapshot itself looks fine
    await revokeGrant(db, created.id, "revoked after snapshot taken", NOW);
    // assertGrantUsable only ever takes grantId - there is no way to pass the stale snapshot
    // in, so this call necessarily re-reads and correctly rejects.
    await expect(assertGrantUsable(db, created.id, NOW)).rejects.toThrow(
      AppError,
    );
  });
});

describe("withGrantHeld", () => {
  it("should resolve, assert usable, and hand the live grant to fn", async () => {
    const walletId = await seedWallet("did:privy:held-test");
    const created = await createGrant(db, GRANT_ENV, {
      principalId: "did:privy:held-test",
      walletId,
      clientId: "client-1",
      scope: "assets:read",
      chainId: 296,
      now: NOW,
    });
    const result = await withGrantHeld(db, created.id, NOW, async (grant) => {
      expect(grant.id).toBe(created.id);
      return "handled";
    });
    expect(result).toBe("handled");
  });

  it("should propagate AppError(DELEGATION_REVOKED) without calling fn", async () => {
    const walletId = await seedWallet("did:privy:held-revoked");
    const created = await createGrant(db, GRANT_ENV, {
      principalId: "did:privy:held-revoked",
      walletId,
      clientId: "client-1",
      scope: "assets:read",
      chainId: 296,
      now: NOW,
    });
    await revokeGrant(db, created.id, "user requested", NOW);
    let fnCalled = false;
    await expect(
      withGrantHeld(db, created.id, NOW, async () => {
        fnCalled = true;
      }),
    ).rejects.toThrow(AppError);
    expect(fnCalled).toBe(false);
  });
});

describe("revokeGrant", () => {
  it("should transition active -> revoked, bump revision, and be idempotent on a second call", async () => {
    const walletId = await seedWallet("did:privy:revoke-idem");
    const created = await createGrant(db, GRANT_ENV, {
      principalId: "did:privy:revoke-idem",
      walletId,
      clientId: "client-1",
      scope: "assets:read",
      chainId: 296,
      now: NOW,
    });
    const first = await revokeGrant(db, created.id, "user requested", NOW);
    expect(first).toBe(true);

    const [row] = await db
      .select()
      .from(agentGrant)
      .where(eq(agentGrant.id, created.id));
    expect(row?.state).toBe("revoked");
    expect(row?.revokedReason).toBe("user requested");
    expect(row?.revision).toBe(1n);

    const second = await revokeGrant(db, created.id, "duplicate call", NOW);
    expect(second).toBe(false); // already revoked: no-op, not a second revocation

    const [rowAfter] = await db
      .select()
      .from(agentGrant)
      .where(eq(agentGrant.id, created.id));
    expect(rowAfter?.revision).toBe(1n); // unchanged by the no-op
    expect(rowAfter?.revokedReason).toBe("user requested"); // not overwritten
  });

  it("should return false for an unknown grant id", async () => {
    const result = await revokeGrant(db, crypto.randomUUID(), "n/a", NOW);
    expect(result).toBe(false);
  });
});

describe("revokeAllDelegations / countActiveDelegations", () => {
  it("should revoke every active grant for a principal, across multiple clients, and leave other principals untouched", async () => {
    const walletId = await seedWallet("did:privy:revoke-all");
    const a = await createGrant(db, GRANT_ENV, {
      principalId: "did:privy:revoke-all",
      walletId,
      clientId: "client-a",
      scope: "assets:read",
      chainId: 296,
      now: NOW,
    });
    const b = await createGrant(db, GRANT_ENV, {
      principalId: "did:privy:revoke-all",
      walletId,
      clientId: "client-b",
      scope: "assets:read",
      chainId: 296,
      now: NOW,
    });
    const otherWalletId = await seedWallet("did:privy:untouched");
    const other = await createGrant(db, GRANT_ENV, {
      principalId: "did:privy:untouched",
      walletId: otherWalletId,
      clientId: "client-a",
      scope: "assets:read",
      chainId: 296,
      now: NOW,
    });

    expect(await countActiveDelegations(db, "did:privy:revoke-all")).toBe(2);

    const revokedIds = await revokeAllDelegations(
      db,
      "did:privy:revoke-all",
      "revoke all requested",
      NOW,
    );
    expect(revokedIds.sort()).toEqual([a.id, b.id].sort());
    expect(await countActiveDelegations(db, "did:privy:revoke-all")).toBe(0);

    const [otherRow] = await db
      .select()
      .from(agentGrant)
      .where(eq(agentGrant.id, other.id));
    expect(otherRow?.state).toBe("active"); // untouched
  });

  it("should return an empty array for a principal with zero active grants", async () => {
    const revokedIds = await revokeAllDelegations(
      db,
      "did:privy:no-grants",
      "n/a",
      NOW,
    );
    expect(revokedIds).toEqual([]);
  });
});
