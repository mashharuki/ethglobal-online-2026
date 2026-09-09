import type { Hono } from "hono";
import { writeAudit } from "../audit/log";
import type { AuthzDb } from "../db/types";
import { AppError } from "../errors";
import { extractBearerToken } from "../mcp/auth";
import {
  countActiveDelegationsForWallet,
  listActiveDelegations,
  resolveDelegation,
  revokeAllDelegations,
  revokeGrant,
} from "../mcp/grant";
import {
  createPrivyDelegationClient,
  detachDelegatedSigner,
  type PrivyDelegationEnv,
  type PrivyPrincipalAuthEnv,
  verifyPrincipalAccessToken,
} from "../mcp/privyClient";
import { resolveWalletBinding } from "../mcp/walletProvisioning";
import { revokeAllTokensForGrant } from "../oauth/revoke";
import type { AppEnv } from "./schemas";

/**
 * Agent delegation admin routes (specs/mcp-auth-remediation-plan.md §"取消", tasks.md Phase
 * 8): list / revoke the AI delegations (`agent_grant`) a principal has granted, for the web
 * "AI access" screen (Phase 9) to call. Authentication here is a SEPARATE trust boundary from
 * `/mcp`'s OAuth Bearer tokens (mcp/auth.ts) - the `Authorization: Bearer <token>` these
 * routes expect is a Privy access token the browser already holds from the user's own login,
 * verified against Privy's JWKS (mcp/privyClient.ts's `verifyPrincipalAccessToken`), never
 * this gateway's own `oauth_token` table.
 *
 * DB revocation is authoritative and happens first; detaching the Privy additional signer is
 * best-effort cleanup afterward (the plan's explicit ordering) - its failure never undoes or
 * fails the revoke itself, only shows up as `signerDetached: false` for the caller to retry
 * later.
 */
async function requirePrincipal(
  env: PrivyPrincipalAuthEnv,
  authorizationHeader: string | null | undefined,
): Promise<string> {
  const token = extractBearerToken(authorizationHeader);
  if (token === undefined) {
    throw new AppError(
      "AUTH_TOKEN_INVALID",
      "missing or malformed Authorization header",
    );
  }
  try {
    const { principalId } = await verifyPrincipalAccessToken(env, token);
    return principalId;
  } catch {
    // Deliberately one code for every failure (misconfigured server, expired/forged/wrong-
    // audience token) - the same "single code, no oracle" choice AUTH_TOKEN_INVALID already
    // makes for /mcp's Bearer auth (mcp/auth.ts).
    throw new AppError("AUTH_TOKEN_INVALID", "invalid or expired access token");
  }
}

/** Best-effort signer-detach: resolves the Privy wallet id from `walletId` (authorization-
 * critical read, so this takes `AuthzDb` like every other read in this route) and swallows
 * any failure (unavailable Privy config, network error, already-detached) into `false` so the
 * caller can report "pending" instead of crashing an otherwise-successful DB revoke. */
async function tryDetachSigner(
  authzDb: AuthzDb,
  delegationEnv: PrivyDelegationEnv,
  walletId: string,
): Promise<boolean> {
  try {
    const wallet = await resolveWalletBinding(authzDb, walletId);
    if (wallet === undefined || wallet.privyWalletId === null) return false;
    const delegation = createPrivyDelegationClient(delegationEnv);
    await detachDelegatedSigner(delegation, wallet.privyWalletId);
    return true;
  } catch {
    return false;
  }
}

export function registerAgentGrantRoutes(app: Hono<AppEnv>): void {
  app.get("/agent/grants", async (c) => {
    const services = c.get("services");
    const authzDb = c.get("authzDb");
    const principalId = await requirePrincipal(
      services.env,
      c.req.header("Authorization"),
    );
    const grants = await listActiveDelegations(authzDb, principalId);
    return c.json({
      grants: grants.map((g) => ({
        id: g.id,
        clientId: g.clientId,
        walletId: g.walletId,
        scope: g.scope,
        chainId: g.chainId,
        expiresAt: g.expiresAt.toISOString(),
        totalBudgetTinybar: g.totalBudgetTinybar.toString(),
        reservedTinybar: g.reservedTinybar.toString(),
        spentTinybar: g.spentTinybar.toString(),
        createdAt: g.createdAt.toISOString(),
      })),
    });
  });

  app.post("/agent/grants/:grantId/revoke", async (c) => {
    const services = c.get("services");
    const authzDb = c.get("authzDb");
    const principalId = await requirePrincipal(
      services.env,
      c.req.header("Authorization"),
    );
    const grantId = c.req.param("grantId");
    const grant = await resolveDelegation(authzDb, grantId);
    // A grant that does not exist and a grant that exists but belongs to someone else answer
    // identically - this endpoint never confirms another principal's grant id exists.
    if (grant === undefined || grant.principalId !== principalId) {
      throw new AppError("DELEGATION_NOT_FOUND");
    }
    const now = services.now();
    await revokeGrant(authzDb, grantId, "principal_requested", now);
    await revokeAllTokensForGrant(authzDb, grantId, now);
    let signerDetached: boolean | undefined;
    const remaining = await countActiveDelegationsForWallet(
      authzDb,
      grant.walletId,
    );
    if (remaining === 0) {
      signerDetached = await tryDetachSigner(
        authzDb,
        services.env,
        grant.walletId,
      );
    }
    await writeAudit(services.db, {
      action: "delegation_revoke",
      subject: {
        principalId,
        grantId,
        walletId: grant.walletId,
        scope: "single",
        signerDetached: signerDetached ?? null,
      },
      outcome: "allow",
    });
    return c.json({ grantId, revoked: true, signerDetached });
  });

  app.post("/agent/grants/revoke-all", async (c) => {
    const services = c.get("services");
    const authzDb = c.get("authzDb");
    const principalId = await requirePrincipal(
      services.env,
      c.req.header("Authorization"),
    );
    const now = services.now();
    const grants = await listActiveDelegations(authzDb, principalId);
    const revokedGrantIds = await revokeAllDelegations(
      authzDb,
      principalId,
      "principal_requested_revoke_all",
      now,
    );
    for (const grantId of revokedGrantIds) {
      await revokeAllTokensForGrant(authzDb, grantId, now);
    }
    // "Revoke all" means every grant this principal had is gone, so every distinct wallet
    // among them is now unused - detach all of them (not just one).
    const walletIds = [...new Set(grants.map((g) => g.walletId))];
    const signerResults: Record<string, boolean> = {};
    for (const walletId of walletIds) {
      signerResults[walletId] = await tryDetachSigner(
        authzDb,
        services.env,
        walletId,
      );
    }
    await writeAudit(services.db, {
      action: "delegation_revoke",
      subject: {
        principalId,
        grantIds: revokedGrantIds,
        scope: "all",
        signerResults,
      },
      outcome: "allow",
    });
    return c.json({ revokedGrantIds, signerResults });
  });
}
