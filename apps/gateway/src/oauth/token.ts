import { and, eq, isNull } from "drizzle-orm";
import { oauthAuthorizationCode, oauthToken } from "../db/schema";
import type { AuthzDb } from "../db/types";
import { assertGrantUsable } from "../mcp/grant";
import { resolveClient } from "./clients";
import { revokeAllTokensForGrant } from "./revoke";
import {
  generateOpaqueValue,
  hashOpaqueValue,
  verifyPkceS256,
} from "./tokenHash";

/**
 * /oauth/token (OAuth 2.1 §4.1.3 authorization_code exchange + §4.3 refresh_token grant,
 * specs/mcp-auth-remediation-plan.md §6/§1.6). Every failure here is an OAuth-standard error
 * response (RFC 6749 §5.2: `{error, error_description}`, never this codebase's own
 * `{error: {code, message}}` AppError shape) - `TokenResult`'s `ok: false` variant carries
 * exactly that.
 */
export const ACCESS_TOKEN_TTL_SEC = 60 * 60; // 1 hour
export const REFRESH_TOKEN_TTL_SEC = 30 * 24 * 60 * 60; // 30 days, capped by the grant's own expiry

export type TokenSuccess = {
  ok: true;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope: string;
};
export type TokenFailure = {
  ok: false;
  status: 400 | 401;
  error: string;
  errorDescription: string;
};
export type TokenResult = TokenSuccess | TokenFailure;

function invalidGrant(errorDescription: string): TokenFailure {
  return { ok: false, status: 400, error: "invalid_grant", errorDescription };
}

async function mintTokenPair(
  db: AuthzDb,
  input: {
    grantId: string;
    clientId: string;
    principalId: string;
    scope: string;
    resource: string;
    now: Date;
    grantExpiresAt: Date;
  },
): Promise<{ accessToken: string; refreshToken: string }> {
  const accessToken = generateOpaqueValue();
  const refreshToken = generateOpaqueValue();
  const refreshExpiresAt = new Date(
    Math.min(
      input.now.getTime() + REFRESH_TOKEN_TTL_SEC * 1000,
      input.grantExpiresAt.getTime(),
    ),
  );
  await db.insert(oauthToken).values([
    {
      tokenHash: hashOpaqueValue(accessToken),
      kind: "access",
      grantId: input.grantId,
      clientId: input.clientId,
      principalId: input.principalId,
      scope: input.scope,
      resource: input.resource,
      expiresAt: new Date(input.now.getTime() + ACCESS_TOKEN_TTL_SEC * 1000),
    },
    {
      tokenHash: hashOpaqueValue(refreshToken),
      kind: "refresh",
      grantId: input.grantId,
      clientId: input.clientId,
      principalId: input.principalId,
      scope: input.scope,
      resource: input.resource,
      expiresAt: refreshExpiresAt,
    },
  ]);
  return { accessToken, refreshToken };
}

export type ExchangeCodeInput = {
  code: string;
  redirectUri: string;
  clientId: string;
  codeVerifier: string;
};

export async function exchangeAuthorizationCode(
  db: AuthzDb,
  input: ExchangeCodeInput,
  now: Date,
): Promise<TokenResult> {
  const codeHash = hashOpaqueValue(input.code);
  const [row] = await db
    .select()
    .from(oauthAuthorizationCode)
    .where(eq(oauthAuthorizationCode.codeHash, codeHash))
    .limit(1);
  if (row === undefined) {
    return invalidGrant("unknown authorization code");
  }
  if (row.usedAt !== null) {
    // Replay: this code should never be exchangeable twice. Treat as a compromise signal and
    // revoke everything already issued from it.
    await revokeAllTokensForGrant(db, row.grantId, now);
    return invalidGrant("authorization code already used");
  }
  if (row.expiresAt <= now) {
    return invalidGrant("authorization code expired");
  }
  if (row.clientId !== input.clientId) {
    return invalidGrant("client_id does not match the authorization request");
  }
  if (row.redirectUri !== input.redirectUri) {
    return invalidGrant(
      "redirect_uri does not match the authorization request",
    );
  }
  if (!(await verifyPkceS256(input.codeVerifier, row.codeChallenge))) {
    return invalidGrant("code_verifier does not match code_challenge");
  }

  // Consume the code with a CAS (WHERE usedAt IS NULL) - two concurrent exchange attempts
  // must not both succeed; the loser (0 rows returned) is treated as a replay, matching the
  // already-used check above.
  const [consumed] = await db
    .update(oauthAuthorizationCode)
    .set({ usedAt: now })
    .where(
      and(
        eq(oauthAuthorizationCode.codeHash, codeHash),
        isNull(oauthAuthorizationCode.usedAt),
      ),
    )
    .returning();
  if (consumed === undefined) {
    await revokeAllTokensForGrant(db, row.grantId, now);
    return invalidGrant("authorization code already used");
  }

  let grant: Awaited<ReturnType<typeof assertGrantUsable>>;
  try {
    grant = await assertGrantUsable(db, row.grantId, now);
  } catch {
    return invalidGrant(
      "the delegation for this authorization has been revoked or expired",
    );
  }

  const { accessToken, refreshToken } = await mintTokenPair(db, {
    grantId: row.grantId,
    clientId: row.clientId,
    principalId: row.principalId,
    scope: row.scope,
    resource: row.resource,
    now,
    grantExpiresAt: grant.expiresAt,
  });
  return {
    ok: true,
    accessToken,
    refreshToken,
    expiresIn: ACCESS_TOKEN_TTL_SEC,
    scope: row.scope,
  };
}

export type RefreshTokenInput = {
  refreshToken: string;
  clientId: string;
};

export async function refreshAccessToken(
  db: AuthzDb,
  input: RefreshTokenInput,
  now: Date,
): Promise<TokenResult> {
  const tokenHash = hashOpaqueValue(input.refreshToken);
  const [row] = await db
    .select()
    .from(oauthToken)
    .where(
      and(eq(oauthToken.tokenHash, tokenHash), eq(oauthToken.kind, "refresh")),
    )
    .limit(1);
  if (row === undefined) {
    return invalidGrant("unknown refresh token");
  }
  if (row.revokedAt !== null) {
    if (row.replacedBy !== null) {
      // This value was already rotated away by a legitimate refresh - presenting it again
      // means someone else has a copy. Revoke the whole family, per OAuth 2.1 §4.14.2.
      await revokeAllTokensForGrant(db, row.grantId, now);
    }
    return invalidGrant("refresh token has been revoked");
  }
  if (row.expiresAt <= now) {
    return invalidGrant("refresh token expired");
  }
  if (row.clientId !== input.clientId) {
    return invalidGrant("client_id does not match this refresh token");
  }

  let grant: Awaited<ReturnType<typeof assertGrantUsable>>;
  try {
    grant = await assertGrantUsable(db, row.grantId, now);
  } catch {
    return invalidGrant(
      "the delegation for this token has been revoked or expired",
    );
  }

  const client = await resolveClient(db, input.clientId);
  const rotationDisabled = client?.refreshRotationDisabled === true;

  if (rotationDisabled) {
    // The single pre-registered CI client (specs/mcp-auth-remediation-plan.md CI section):
    // reuse the same refresh token indefinitely - CI has no safe way to persist a
    // newly-rotated value back to itself between runs.
    const accessToken = generateOpaqueValue();
    await db.insert(oauthToken).values({
      tokenHash: hashOpaqueValue(accessToken),
      kind: "access",
      grantId: row.grantId,
      clientId: row.clientId,
      principalId: row.principalId,
      scope: row.scope,
      resource: row.resource,
      expiresAt: new Date(now.getTime() + ACCESS_TOKEN_TTL_SEC * 1000),
    });
    return {
      ok: true,
      accessToken,
      refreshToken: input.refreshToken,
      expiresIn: ACCESS_TOKEN_TTL_SEC,
      scope: row.scope,
    };
  }

  // Rotate: claim the presented refresh token with a CAS (WHERE revokedAt IS NULL) BEFORE
  // minting anything - two concurrent refresh calls with the same token must not both
  // succeed. The loser (0 rows) is treated the same as a legitimately-revoked token; the
  // winner records a placeholder `replacedBy` first (the real value, once minted, is filled
  // in right after) so the claim itself - not what it's replaced by - is what serializes the
  // race, with no risk of an unlinked, un-rotated new pair ever being minted for a loser.
  const claimToken = generateOpaqueValue();
  const [claimed] = await db
    .update(oauthToken)
    .set({ revokedAt: now, replacedBy: hashOpaqueValue(claimToken) })
    .where(
      and(eq(oauthToken.tokenHash, tokenHash), isNull(oauthToken.revokedAt)),
    )
    .returning();
  if (claimed === undefined) {
    return invalidGrant("refresh token has been revoked");
  }

  const { accessToken, refreshToken: newRefreshToken } = await mintTokenPair(
    db,
    {
      grantId: row.grantId,
      clientId: row.clientId,
      principalId: row.principalId,
      scope: row.scope,
      resource: row.resource,
      now,
      grantExpiresAt: grant.expiresAt,
    },
  );
  // Now that the real new refresh token exists, point `replacedBy` at it instead of the
  // throwaway claim value above.
  await db
    .update(oauthToken)
    .set({ replacedBy: hashOpaqueValue(newRefreshToken) })
    .where(eq(oauthToken.tokenHash, tokenHash));

  return {
    ok: true,
    accessToken,
    refreshToken: newRefreshToken,
    expiresIn: ACCESS_TOKEN_TTL_SEC,
    scope: row.scope,
  };
}
