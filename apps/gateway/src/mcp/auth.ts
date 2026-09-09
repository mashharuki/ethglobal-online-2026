import { and, eq } from "drizzle-orm";
import type { Hex } from "viem";
import { mcpAuthenticatedSession, oauthToken } from "../db/schema";
import type { AuthzDb } from "../db/types";
import { AppError } from "../errors";
import { hashOpaqueValue } from "../oauth/tokenHash";
import { assertGrantUsable } from "./grant";

/**
 * MCP Bearer-token authentication (specs/mcp-auth-remediation-plan.md §7). `/mcp` itself
 * never hard-401s (discover_assets must keep working unauthenticated); a caller becomes an
 * `McpPrincipal` only if it presents a valid `Authorization: Bearer <access token>`, and
 * `withScope` (server.ts) is what actually gates `buy_access` / `decrypt_content` on it being
 * present with the right scope.
 */
export type McpPrincipal = {
  principalId: string;
  grantId: string;
  walletId: string;
  clientId: string;
  scope: string;
};

const BEARER_PREFIX = "Bearer ";

export function extractBearerToken(
  authorizationHeader: string | null | undefined,
): string | undefined {
  if (typeof authorizationHeader !== "string") return undefined;
  if (!authorizationHeader.startsWith(BEARER_PREFIX)) return undefined;
  const token = authorizationHeader.slice(BEARER_PREFIX.length).trim();
  return token.length > 0 ? token : undefined;
}

/**
 * Bearer token -> live principal. Every field on the returned principal traces back to a
 * fresh read taken THIS call: the token row is read by its hash (never trusted from a cache),
 * and the grant it belongs to is re-validated via `assertGrantUsable` rather than assumed
 * usable because the token itself hasn't expired - a revoke that lands between two tool calls
 * in the same MCP session must take effect on the very next request (Constitution Principle
 * II). `assertGrantUsable`'s own `DELEGATION_REVOKED` / `DELEGATION_EXPIRED` are left to
 * propagate as-is (not collapsed into `AUTH_TOKEN_INVALID`) so a caller can tell "your token is
 * garbage" apart from "your token is fine, but the delegation behind it was revoked".
 */
export async function requireMcpAuth(
  authzDb: AuthzDb,
  authorizationHeader: string | null | undefined,
  now: Date,
): Promise<McpPrincipal> {
  const token = extractBearerToken(authorizationHeader);
  if (token === undefined) {
    throw new AppError(
      "AUTH_TOKEN_INVALID",
      "missing or malformed Authorization header",
    );
  }
  const tokenHash = hashOpaqueValue(token);
  const [row] = await authzDb
    .select()
    .from(oauthToken)
    .where(
      and(eq(oauthToken.tokenHash, tokenHash), eq(oauthToken.kind, "access")),
    )
    .limit(1);
  if (row === undefined || row.revokedAt !== null || row.expiresAt <= now) {
    throw new AppError(
      "AUTH_TOKEN_INVALID",
      "access token is invalid, expired, or revoked",
    );
  }
  const grant = await assertGrantUsable(authzDb, row.grantId, now);
  return {
    principalId: row.principalId,
    grantId: row.grantId,
    walletId: grant.walletId,
    clientId: row.clientId,
    scope: row.scope,
  };
}

/**
 * Idempotent: binds an `Mcp-Session-Id` to the principal that authenticated its `initialize`
 * call. A retried/duplicate `initialize` for the same session key is a no-op, never a second
 * row or an error.
 */
export async function openAuthenticatedSession(
  authzDb: AuthzDb,
  sessionKey: Hex,
  principal: McpPrincipal,
  now: Date,
): Promise<void> {
  await authzDb
    .insert(mcpAuthenticatedSession)
    .values({
      sessionKey,
      principalId: principal.principalId,
      grantId: principal.grantId,
      walletId: principal.walletId,
      clientId: principal.clientId,
      createdAt: now,
      lastSeenAt: now,
    })
    .onConflictDoNothing();
}

/**
 * Read-only per-request check that a session's recorded principal still matches the Bearer
 * token presented on THIS call - a session `initialize`d by principal A must not be usable by
 * principal B just because they both happen to echo the same `Mcp-Session-Id`.
 */
export async function assertSessionMatchesPrincipal(
  authzDb: AuthzDb,
  sessionKey: Hex,
  principal: McpPrincipal,
): Promise<void> {
  const [row] = await authzDb
    .select()
    .from(mcpAuthenticatedSession)
    .where(eq(mcpAuthenticatedSession.sessionKey, sessionKey))
    .limit(1);
  if (
    row === undefined ||
    row.revokedAt !== null ||
    row.principalId !== principal.principalId
  ) {
    throw new AppError(
      "MCP_SESSION_MISMATCH",
      "this MCP session is not bound to the authenticated principal",
    );
  }
}
