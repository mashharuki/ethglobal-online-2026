import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  agentGrant,
  agentWalletBinding,
  oauthAuthorizationCode,
  oauthToken,
} from "../../src/db/schema";
import type { AuthzDb } from "../../src/db/types";
import { registerClient } from "../../src/oauth/clients";
import {
  ACCESS_TOKEN_TTL_SEC,
  exchangeAuthorizationCode,
  refreshAccessToken,
} from "../../src/oauth/token";
import {
  generateOpaqueValue,
  hashOpaqueValue,
} from "../../src/oauth/tokenHash";
import { createTestDb } from "./helpers";

const NOW = new Date("2026-09-09T12:00:00Z");
const CODE_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CODE_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"; // SHA256(CODE_VERIFIER)
const REDIRECT_URI = "https://client.example/cb";

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

/** Simulates what the not-yet-built /oauth/consent would have produced: a wallet, an active
 * grant, and a single-use authorization code bound to it. */
async function seedConsentedCode(overrides: {
  clientId?: string;
  grantExpiresAt?: Date;
  codeExpiresAt?: Date;
  usedAt?: Date | null;
  refreshRotationDisabled?: boolean;
}) {
  const principalId = "did:privy:token-test";
  const walletId = crypto.randomUUID();
  const addressSeed = nextWalletAddressSeed++;
  await db.insert(agentWalletBinding).values({
    id: walletId,
    principalId,
    purpose: "mcp-agent",
    chainType: "ethereum",
    chainId: 296,
    delegationShape: "additional-signer",
    externalId: `aiwallet-token-test-${walletId}`,
    provisioningKey: `aiwallet:v1:token-test:${walletId}`,
    provisioningState: "active",
    privyWalletId: `privy-${walletId}`,
    address: `0x${String(addressSeed).padStart(40, "0")}`,
    signerQuorumId: "quorum-1",
    signerState: "attached",
    ownerVerifiedAt: NOW,
  });
  const registeredClient =
    overrides.clientId === undefined
      ? await registerClient(db, {
          clientName: "test client",
          redirectUris: [REDIRECT_URI],
          scope: undefined,
        })
      : undefined;
  const clientId = overrides.clientId ?? (registeredClient?.clientId as string);
  if (overrides.refreshRotationDisabled) {
    const { oauthClient } = await import("../../src/db/schema");
    await db
      .update(oauthClient)
      .set({ refreshRotationDisabled: true })
      .where(eq(oauthClient.clientId, clientId));
  }
  const grantId = crypto.randomUUID();
  await db.insert(agentGrant).values({
    id: grantId,
    principalId,
    walletId,
    clientId,
    scope: "assets:read access:buy",
    chainId: 296,
    expiresAt: overrides.grantExpiresAt ?? new Date(NOW.getTime() + 3_600_000),
    totalBudgetTinybar: 10_000_000n,
    maxPerPurchaseTinybar: 1_000_000n,
  });
  const code = generateOpaqueValue();
  await db.insert(oauthAuthorizationCode).values({
    codeHash: hashOpaqueValue(code),
    requestIdHash: hashOpaqueValue(generateOpaqueValue()),
    clientId,
    principalId,
    grantId,
    redirectUri: REDIRECT_URI,
    codeChallenge: CODE_CHALLENGE,
    scope: "assets:read access:buy",
    resource: "https://gateway.example/mcp",
    expiresAt: overrides.codeExpiresAt ?? new Date(NOW.getTime() + 60_000),
    usedAt: overrides.usedAt ?? null,
  });
  return { code, clientId, grantId, principalId };
}

describe("exchangeAuthorizationCode", () => {
  it("should mint an access + refresh token pair for a valid code", async () => {
    const { code, clientId } = await seedConsentedCode({});
    const result = await exchangeAuthorizationCode(
      db,
      {
        code,
        redirectUri: REDIRECT_URI,
        clientId,
        codeVerifier: CODE_VERIFIER,
      },
      NOW,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.expiresIn).toBe(ACCESS_TOKEN_TTL_SEC);
    expect(result.scope).toBe("assets:read access:buy");

    const [accessRow] = await db
      .select()
      .from(oauthToken)
      .where(eq(oauthToken.tokenHash, hashOpaqueValue(result.accessToken)));
    expect(accessRow?.kind).toBe("access");
    const [refreshRow] = await db
      .select()
      .from(oauthToken)
      .where(eq(oauthToken.tokenHash, hashOpaqueValue(result.refreshToken)));
    expect(refreshRow?.kind).toBe("refresh");
  });

  it("should mark the code as used and reject a second exchange (replay), revoking any tokens already issued", async () => {
    const { code, clientId } = await seedConsentedCode({});
    const first = await exchangeAuthorizationCode(
      db,
      {
        code,
        redirectUri: REDIRECT_URI,
        clientId,
        codeVerifier: CODE_VERIFIER,
      },
      NOW,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("unreachable");

    const second = await exchangeAuthorizationCode(
      db,
      {
        code,
        redirectUri: REDIRECT_URI,
        clientId,
        codeVerifier: CODE_VERIFIER,
      },
      NOW,
    );
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("unreachable");
    expect(second.error).toBe("invalid_grant");

    const [accessRow] = await db
      .select()
      .from(oauthToken)
      .where(eq(oauthToken.tokenHash, hashOpaqueValue(first.accessToken)));
    expect(accessRow?.revokedAt).not.toBeNull(); // replay revoked the earlier-issued token
  });

  it("should reject an unknown code", async () => {
    const result = await exchangeAuthorizationCode(
      db,
      {
        code: generateOpaqueValue(),
        redirectUri: REDIRECT_URI,
        clientId: crypto.randomUUID(),
        codeVerifier: CODE_VERIFIER,
      },
      NOW,
    );
    expect(result.ok).toBe(false);
  });

  it("should reject an expired code", async () => {
    const { code, clientId } = await seedConsentedCode({
      codeExpiresAt: new Date(NOW.getTime() - 1000),
    });
    const result = await exchangeAuthorizationCode(
      db,
      {
        code,
        redirectUri: REDIRECT_URI,
        clientId,
        codeVerifier: CODE_VERIFIER,
      },
      NOW,
    );
    expect(result.ok).toBe(false);
  });

  it("should reject a client_id mismatch", async () => {
    const { code } = await seedConsentedCode({});
    const result = await exchangeAuthorizationCode(
      db,
      {
        code,
        redirectUri: REDIRECT_URI,
        clientId: crypto.randomUUID(),
        codeVerifier: CODE_VERIFIER,
      },
      NOW,
    );
    expect(result.ok).toBe(false);
  });

  it("should reject a redirect_uri mismatch", async () => {
    const { code, clientId } = await seedConsentedCode({});
    const result = await exchangeAuthorizationCode(
      db,
      {
        code,
        redirectUri: "https://different.example/cb",
        clientId,
        codeVerifier: CODE_VERIFIER,
      },
      NOW,
    );
    expect(result.ok).toBe(false);
  });

  it("should reject a wrong code_verifier", async () => {
    const { code, clientId } = await seedConsentedCode({});
    const result = await exchangeAuthorizationCode(
      db,
      {
        code,
        redirectUri: REDIRECT_URI,
        clientId,
        codeVerifier: "wrong-verifier-wrong-verifier-wrong-verifier",
      },
      NOW,
    );
    expect(result.ok).toBe(false);
  });

  it("should reject exchange for a code whose underlying grant has already expired", async () => {
    const { code, clientId } = await seedConsentedCode({
      grantExpiresAt: new Date(NOW.getTime() - 1000),
    });
    const result = await exchangeAuthorizationCode(
      db,
      {
        code,
        redirectUri: REDIRECT_URI,
        clientId,
        codeVerifier: CODE_VERIFIER,
      },
      NOW,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toBe("invalid_grant");
  });

  it("should cap the minted refresh token's expiry at the grant's own expiresAt", async () => {
    const grantExpiresAt = new Date(NOW.getTime() + 60_000); // much sooner than the 30-day default
    const { code, clientId } = await seedConsentedCode({ grantExpiresAt });
    const result = await exchangeAuthorizationCode(
      db,
      {
        code,
        redirectUri: REDIRECT_URI,
        clientId,
        codeVerifier: CODE_VERIFIER,
      },
      NOW,
    );
    if (!result.ok) throw new Error("unreachable");
    const [refreshRow] = await db
      .select()
      .from(oauthToken)
      .where(eq(oauthToken.tokenHash, hashOpaqueValue(result.refreshToken)));
    expect(refreshRow?.expiresAt.getTime()).toBe(grantExpiresAt.getTime());
  });
});

describe("refreshAccessToken", () => {
  async function issueTokens(
    overrides: Parameters<typeof seedConsentedCode>[0] = {},
  ) {
    const { code, clientId, grantId } = await seedConsentedCode(overrides);
    const result = await exchangeAuthorizationCode(
      db,
      {
        code,
        redirectUri: REDIRECT_URI,
        clientId,
        codeVerifier: CODE_VERIFIER,
      },
      NOW,
    );
    if (!result.ok) throw new Error("setup failed");
    return { ...result, clientId, grantId };
  }

  it("should rotate: mint a new pair and revoke the old refresh token, recording replacedBy", async () => {
    const issued = await issueTokens();
    const refreshed = await refreshAccessToken(
      db,
      { refreshToken: issued.refreshToken, clientId: issued.clientId },
      NOW,
    );
    expect(refreshed.ok).toBe(true);
    if (!refreshed.ok) throw new Error("unreachable");
    expect(refreshed.refreshToken).not.toBe(issued.refreshToken);

    const [oldRow] = await db
      .select()
      .from(oauthToken)
      .where(eq(oauthToken.tokenHash, hashOpaqueValue(issued.refreshToken)));
    expect(oldRow?.revokedAt).not.toBeNull();
    expect(oldRow?.replacedBy).toEqual(hashOpaqueValue(refreshed.refreshToken));
  });

  it("should reject reuse of an already-rotated refresh token and revoke the whole token family", async () => {
    const issued = await issueTokens();
    const firstRefresh = await refreshAccessToken(
      db,
      { refreshToken: issued.refreshToken, clientId: issued.clientId },
      NOW,
    );
    expect(firstRefresh.ok).toBe(true);

    // presenting the ORIGINAL (now-rotated-away) refresh token again
    const reuseAttempt = await refreshAccessToken(
      db,
      { refreshToken: issued.refreshToken, clientId: issued.clientId },
      NOW,
    );
    expect(reuseAttempt.ok).toBe(false);

    if (!firstRefresh.ok) throw new Error("unreachable");
    const [newAccessRow] = await db
      .select()
      .from(oauthToken)
      .where(
        eq(oauthToken.tokenHash, hashOpaqueValue(firstRefresh.accessToken)),
      );
    // the whole family (including the token minted by the legitimate first refresh) is
    // revoked in response to the reuse signal
    expect(newAccessRow?.revokedAt).not.toBeNull();
  });

  it("should not rotate for a client with refreshRotationDisabled (CI) - same refresh token stays valid", async () => {
    const issued = await issueTokens({ refreshRotationDisabled: true });
    const first = await refreshAccessToken(
      db,
      { refreshToken: issued.refreshToken, clientId: issued.clientId },
      NOW,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("unreachable");
    expect(first.refreshToken).toBe(issued.refreshToken);

    const second = await refreshAccessToken(
      db,
      { refreshToken: issued.refreshToken, clientId: issued.clientId },
      NOW,
    );
    expect(second.ok).toBe(true); // still valid - no rotation, no reuse-detection trip
  });

  it("should reject refresh for a revoked underlying grant, even with an otherwise-valid refresh token", async () => {
    const issued = await issueTokens();
    await db
      .update(agentGrant)
      .set({ state: "revoked", revokedAt: NOW, revokedReason: "test" })
      .where(eq(agentGrant.id, issued.grantId));
    const result = await refreshAccessToken(
      db,
      { refreshToken: issued.refreshToken, clientId: issued.clientId },
      NOW,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toBe("invalid_grant");
  });

  it("should reject an unknown refresh token", async () => {
    const result = await refreshAccessToken(
      db,
      { refreshToken: generateOpaqueValue(), clientId: crypto.randomUUID() },
      NOW,
    );
    expect(result.ok).toBe(false);
  });

  it("should reject a client_id mismatch", async () => {
    const issued = await issueTokens();
    const result = await refreshAccessToken(
      db,
      { refreshToken: issued.refreshToken, clientId: crypto.randomUUID() },
      NOW,
    );
    expect(result.ok).toBe(false);
  });
});
