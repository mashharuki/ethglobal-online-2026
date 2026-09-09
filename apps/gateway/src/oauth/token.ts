import { and, eq, isNull } from "drizzle-orm";
import { oauthAuthorizationCode, oauthToken } from "../db/schema";
import type { AuthzDb } from "../db/types";
import { assertGrantUsable } from "../mcp/grant";
import { assertClientUsable } from "./clients";
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
 * exactly that. `error_description` is deliberately the SAME generic string for every
 * invalid_grant cause (Codex review) - distinguishing "unknown code" from "expired" from
 * "wrong client" externally would let an attacker probing this endpoint learn which check
 * failed; the specific reason is only ever visible in this module's own logic, not the wire
 * response.
 *
 * Both grant types run their whole claim-then-mint sequence inside a single db.transaction()
 * (Codex review, Critical): without that, a concurrent second attempt on the same code/token
 * could detect the replay/reuse and revoke the grant's tokens *before* the first (legitimate,
 * winning) request's own INSERT of its new pair had committed - leaving that freshly-minted
 * pair alive and unrevoked despite the compromise signal that was supposed to kill it. Postgres
 * row-level locking inside a transaction is what actually closes this: a second UPDATE against
 * the same row blocks until the first transaction commits, so by the time the loser's
 * revoke-the-family call runs, the winner's tokens are guaranteed to already exist.
 */
export const ACCESS_TOKEN_TTL_SEC = 60 * 60; // 1 hour
export const REFRESH_TOKEN_TTL_SEC = 30 * 24 * 60 * 60; // 30 days, capped by the grant's own expiry
const GENERIC_INVALID_GRANT =
  "the provided authorization grant is invalid, expired, or revoked";

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

const INVALID_GRANT: TokenFailure = {
  ok: false,
  status: 400,
  error: "invalid_grant",
  errorDescription: GENERIC_INVALID_GRANT,
};

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
  resource?: string;
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
    return INVALID_GRANT;
  }
  // Bindings that don't depend on the code's used/expired state are checked FIRST (Codex
  // review, Warning): in particular, PKCE proves the caller actually holds the verifier the
  // original client generated. Without this ordering, anyone who merely observed an
  // already-used code value (e.g. via a browser history entry, referrer leak, or log) could
  // trigger the destructive "replay -> revoke the whole grant's tokens" response below against
  // a victim's active session, without knowing anything secret.
  if (row.clientId !== input.clientId) {
    return INVALID_GRANT;
  }
  if (row.redirectUri !== input.redirectUri) {
    return INVALID_GRANT;
  }
  if (input.resource !== undefined && input.resource !== row.resource) {
    return { ...INVALID_GRANT, error: "invalid_target" };
  }
  if (!(await verifyPkceS256(input.codeVerifier, row.codeChallenge))) {
    return INVALID_GRANT;
  }
  // Only a caller who passed every check above (and is therefore assumed to be the original
  // client, or someone who has fully compromised it) reaches the destructive replay path.
  if (row.usedAt !== null) {
    await revokeAllTokensForGrant(db, row.grantId, now);
    return INVALID_GRANT;
  }
  if (row.expiresAt <= now) {
    return INVALID_GRANT;
  }

  return db.transaction(async (tx) => {
    const authzTx = tx as unknown as AuthzDb;
    // Consume the code with a CAS (WHERE usedAt IS NULL) - the row lock this UPDATE takes is
    // held until this transaction commits, so a concurrent second attempt's own UPDATE (and
    // therefore its revoke-the-family response, below) cannot proceed until this transaction's
    // token INSERT has already committed.
    const [consumed] = await tx
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
      await revokeAllTokensForGrant(authzTx, row.grantId, now);
      return INVALID_GRANT;
    }

    let client: Awaited<ReturnType<typeof assertClientUsable>>;
    let grant: Awaited<ReturnType<typeof assertGrantUsable>>;
    try {
      client = await assertClientUsable(authzTx, input.clientId);
      grant = await assertGrantUsable(authzTx, row.grantId, now);
    } catch {
      return INVALID_GRANT;
    }
    void client;

    const { accessToken, refreshToken } = await mintTokenPair(authzTx, {
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
  });
}

export type RefreshTokenInput = {
  refreshToken: string;
  clientId: string;
  resource?: string;
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
    return INVALID_GRANT;
  }
  if (row.clientId !== input.clientId) {
    return INVALID_GRANT;
  }
  if (input.resource !== undefined && input.resource !== row.resource) {
    return { ...INVALID_GRANT, error: "invalid_target" };
  }
  if (row.revokedAt !== null) {
    if (row.replacedBy !== null) {
      // Already rotated away by a legitimate refresh - presenting it again means someone else
      // has a copy. Revoke the whole family, per OAuth 2.1 §4.14.2.
      await revokeAllTokensForGrant(db, row.grantId, now);
    }
    return INVALID_GRANT;
  }
  if (row.expiresAt <= now) {
    return INVALID_GRANT;
  }

  let client: Awaited<ReturnType<typeof assertClientUsable>>;
  let grant: Awaited<ReturnType<typeof assertGrantUsable>>;
  try {
    client = await assertClientUsable(db, input.clientId);
    grant = await assertGrantUsable(db, row.grantId, now);
  } catch {
    return INVALID_GRANT;
  }

  if (client.refreshRotationDisabled) {
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

  return db.transaction(async (tx) => {
    const authzTx = tx as unknown as AuthzDb;
    // Claim the presented refresh token with a CAS (WHERE revokedAt IS NULL) BEFORE minting
    // anything - the row lock this UPDATE takes is held until this transaction commits, so a
    // concurrent second presentation of the same token cannot observe (or fail to observe)
    // this claim in a way that lets it mint its own valid pair too.
    const claimToken = generateOpaqueValue();
    const [claimed] = await tx
      .update(oauthToken)
      .set({ revokedAt: now, replacedBy: hashOpaqueValue(claimToken) })
      .where(
        and(eq(oauthToken.tokenHash, tokenHash), isNull(oauthToken.revokedAt)),
      )
      .returning();
    if (claimed === undefined) {
      // Lost the race: someone else's request already claimed this token in the gap between
      // our SELECT above and this UPDATE. Re-read to find out how it was claimed - a
      // `replacedBy` means a rotation won the race (Codex review, Critical: this concurrent
      // case is just as much a reuse signal as the "already rotated, presented again later"
      // case above, and must trigger the same family-wide revocation, not a bare denial).
      const [current] = await tx
        .select({ replacedBy: oauthToken.replacedBy })
        .from(oauthToken)
        .where(eq(oauthToken.tokenHash, tokenHash))
        .limit(1);
      if (current?.replacedBy !== null && current?.replacedBy !== undefined) {
        await revokeAllTokensForGrant(authzTx, row.grantId, now);
      }
      return INVALID_GRANT;
    }

    const { accessToken, refreshToken: newRefreshToken } = await mintTokenPair(
      authzTx,
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
    await tx
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
  });
}
