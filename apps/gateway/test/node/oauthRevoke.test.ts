import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  agentGrant,
  agentWalletBinding,
  oauthToken,
} from "../../src/db/schema";
import type { AuthzDb } from "../../src/db/types";
import { registerClient } from "../../src/oauth/clients";
import { revokeAllTokensForGrant, revokeToken } from "../../src/oauth/revoke";
import {
  generateOpaqueValue,
  hashOpaqueValue,
} from "../../src/oauth/tokenHash";
import { createTestDb } from "./helpers";

const NOW = new Date("2026-09-09T12:00:00Z");

let db: AuthzDb;
let client: PGlite;
let nextWalletAddressSeed = 1;

beforeEach(async () => {
  const handle = await createTestDb();
  db = handle.db as unknown as AuthzDb;
  client = handle.client;
});

afterEach(async () => {
  await client.close();
});

async function seedTokens(): Promise<{ grantId: string; token: string }> {
  const addressSeed = nextWalletAddressSeed++;
  const principalId = `did:privy:revoke-test-${addressSeed}`;
  const walletId = crypto.randomUUID();
  await db.insert(agentWalletBinding).values({
    id: walletId,
    principalId,
    purpose: "mcp-agent",
    chainType: "ethereum",
    chainId: 296,
    delegationShape: "additional-signer",
    externalId: `aiwallet-revoke-test-${walletId}`,
    provisioningKey: `aiwallet:v1:revoke-test:${walletId}`,
    provisioningState: "active",
    privyWalletId: `privy-${walletId}`,
    address: `0x${String(addressSeed).padStart(40, "0")}`,
    signerQuorumId: "quorum-1",
    signerState: "attached",
    ownerVerifiedAt: NOW,
  });
  const registered = await registerClient(db, {
    clientName: "x",
    redirectUris: ["https://client.example/cb"],
  });
  const grantId = crypto.randomUUID();
  await db.insert(agentGrant).values({
    id: grantId,
    principalId,
    walletId,
    clientId: registered.clientId,
    scope: "assets:read",
    chainId: 296,
    expiresAt: new Date(NOW.getTime() + 3_600_000),
    totalBudgetTinybar: 10_000_000n,
    maxPerPurchaseTinybar: 1_000_000n,
  });
  const token = generateOpaqueValue();
  await db.insert(oauthToken).values({
    tokenHash: hashOpaqueValue(token),
    kind: "access",
    grantId,
    clientId: registered.clientId,
    principalId,
    scope: "assets:read",
    resource: "https://gateway.example/mcp",
    expiresAt: new Date(NOW.getTime() + 3_600_000),
  });
  return { grantId, token };
}

describe("revokeToken", () => {
  it("should mark an existing token as revoked", async () => {
    const { token } = await seedTokens();
    await revokeToken(db, token, NOW);
    const [row] = await db
      .select()
      .from(oauthToken)
      .where(eq(oauthToken.tokenHash, hashOpaqueValue(token)));
    expect(row?.revokedAt).not.toBeNull();
  });

  it("should not throw for an unknown token (RFC 7009 §2.2)", async () => {
    await expect(
      revokeToken(db, generateOpaqueValue(), NOW),
    ).resolves.toBeUndefined();
  });

  it("should be idempotent: revoking an already-revoked token again does not change its revokedAt", async () => {
    const { token } = await seedTokens();
    await revokeToken(db, token, NOW);
    const later = new Date(NOW.getTime() + 60_000);
    await revokeToken(db, token, later);
    const [row] = await db
      .select()
      .from(oauthToken)
      .where(eq(oauthToken.tokenHash, hashOpaqueValue(token)));
    expect(row?.revokedAt?.getTime()).toBe(NOW.getTime()); // unchanged by the second call
  });
});

describe("revokeAllTokensForGrant", () => {
  it("should revoke every still-active token for the grant, and leave other grants untouched", async () => {
    const a = await seedTokens();
    const b = await seedTokens();

    await revokeAllTokensForGrant(db, a.grantId, NOW);

    const [aRow] = await db
      .select()
      .from(oauthToken)
      .where(eq(oauthToken.tokenHash, hashOpaqueValue(a.token)));
    expect(aRow?.revokedAt).not.toBeNull();

    const [bRow] = await db
      .select()
      .from(oauthToken)
      .where(eq(oauthToken.tokenHash, hashOpaqueValue(b.token)));
    expect(bRow?.revokedAt).toBeNull();
  });
});
