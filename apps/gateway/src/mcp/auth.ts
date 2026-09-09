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

const BEARER_SCHEME = "bearer";

/** HTTP auth-scheme tokens are case-insensitive (RFC 7235 §2.1) - real clients send `bearer`
 * as often as `Bearer` (Codex review, Phase 7: a strict `"Bearer "` prefix match silently
 * rejected those as "no token"). Only the scheme is case-folded; the token value itself is
 * opaque and compared byte-for-byte via its hash. */
export function extractBearerToken(
  authorizationHeader: string | null | undefined,
): string | undefined {
  if (typeof authorizationHeader !== "string") return undefined;
  const spaceIndex = authorizationHeader.indexOf(" ");
  if (spaceIndex === -1) return undefined;
  if (
    authorizationHeader.slice(0, spaceIndex).toLowerCase() !== BEARER_SCHEME
  ) {
    return undefined;
  }
  const token = authorizationHeader.slice(spaceIndex + 1).trim();
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
 * The three states a `/mcp` request can be in after best-effort auth (routes/mcp.ts):
 * - "none": no Authorization header at all - the pre-remediation, still-supported legacy path.
 * - "failed": a header WAS presented but rejected (unknown/expired/revoked token, or a
 *   revoked/expired delegation behind it) - this must never be treated the same as "none"
 *   (Codex review, Phase 7: collapsing both into a bare `undefined` let a caller presenting a
 *   garbage token silently fall back to legacy unauthenticated access while
 *   MCP_AUTH_REQUIRED=false, instead of being refused - a presented-but-invalid credential
 *   should always fail closed, regardless of the cutover flag).
 * - "authenticated": a valid Bearer token, carrying the live principal.
 */
export type AuthAttempt =
  | { kind: "none" }
  | { kind: "failed" }
  | { kind: "authenticated"; principal: McpPrincipal };

/**
 * Best-effort wrapper around `requireMcpAuth` for `/mcp`'s route handler, which must never
 * hard-401 the whole endpoint (`discover_assets` has to keep working with no Authorization
 * header at all). A rejection this function KNOWS is a credential problem (any `AppError` -
 * `AUTH_TOKEN_INVALID`/`DELEGATION_REVOKED`/`DELEGATION_EXPIRED`/`DELEGATION_NOT_FOUND`)
 * becomes `{ kind: "failed" }`; anything else (a genuine DB/infra failure) is rethrown rather
 * than misreported as an invalid credential (Codex review, Phase 7).
 */
export async function attemptMcpAuth(
  authzDb: AuthzDb,
  authorizationHeader: string | null | undefined,
  now: Date,
): Promise<AuthAttempt> {
  if (typeof authorizationHeader !== "string") return { kind: "none" };
  try {
    const principal = await requireMcpAuth(authzDb, authorizationHeader, now);
    return { kind: "authenticated", principal };
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    return { kind: "failed" };
  }
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
