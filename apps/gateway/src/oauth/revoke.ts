import { and, eq, isNull } from "drizzle-orm";
import { oauthToken } from "../db/schema";
import type { AuthzDb } from "../db/types";
import { hashOpaqueValue } from "./tokenHash";

/**
 * Token revocation (RFC 7009, specs/mcp-auth-remediation-plan.md §6). `revokeToken` is
 * intentionally silent about whether the token existed or was already revoked - RFC 7009 §2.2
 * requires the endpoint to answer 200 either way, so a caller can't use it to probe which
 * tokens are currently valid.
 */
export async function revokeToken(
  db: AuthzDb,
  tokenValue: string,
  now: Date,
): Promise<void> {
  await db
    .update(oauthToken)
    .set({ revokedAt: now })
    .where(
      and(
        eq(oauthToken.tokenHash, hashOpaqueValue(tokenValue)),
        isNull(oauthToken.revokedAt),
      ),
    );
}

/**
 * Revokes every still-active token for a grant - the security response to two signals
 * token.ts detects: an authorization code presented a second time (it should never have been
 * exchangeable again, so anything issued from it is suspect), and a rotated-away refresh
 * token presented again (RFC 6749bis / OAuth 2.1 §4.14.2 refresh token reuse detection - a
 * prior rotation means a legitimate client already moved on, so a second use of the old value
 * signals it was captured by someone else).
 */
export async function revokeAllTokensForGrant(
  db: AuthzDb,
  grantId: string,
  now: Date,
): Promise<void> {
  await db
    .update(oauthToken)
    .set({ revokedAt: now })
    .where(and(eq(oauthToken.grantId, grantId), isNull(oauthToken.revokedAt)));
}
