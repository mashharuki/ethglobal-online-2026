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
 *
 * KNOWN LIMITATION (Codex review, Phase 8, accepted for this PR - not a security bypass): the
 * "count active grants on this wallet, then detach" sequence is check-then-act, not
 * transactionally serialized against a NEW grant being created for the same wallet in that
 * narrow window. Worst case, a just-created grant's Privy signer gets detached too - the
 * grant itself stays correctly `active` in the DB (this gateway's own authorization never
 * reads Privy's signer-attachment state at request time), so the caller just has to redo
 * consent for that wallet; no unauthorized access is possible either way. Closing this fully
 * needs a wallet-scoped lock shared with grant creation (grant.ts's `createGrant`), and a
 * durable "detach pending/failed" retry story keyed on `agent_wallet_binding.signerState`
 * (currently unused by this file) rather than best-effort-and-forget - tracked as a follow-up,
 * out of scope for the admin routes themselves.
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
    const revokedGrantIds = await revokeAllDelegations(
      authzDb,
      principalId,
      "principal_requested_revoke_all",
      now,
    );
    // Wallets to check are derived from the grants the atomic revoke ITSELF returned, never
    // from a pre-revoke snapshot (Codex review, Phase 8: a snapshot taken before
    // revokeAllDelegations's own fresh read can miss a grant created in between, leaving its
    // wallet un-checked). Re-reading each grant post-revoke also means a wallet only ever
    // enters `walletIds` once its state is `revoked` in the DB.
    const walletIds = new Set<string>();
    for (const grantId of revokedGrantIds) {
      await revokeAllTokensForGrant(authzDb, grantId, now);
      const grant = await resolveDelegation(authzDb, grantId);
      if (grant !== undefined) walletIds.add(grant.walletId);
    }
    // Same gate as the single-grant route, applied per wallet immediately before its own
    // detach attempt: a grant created for this wallet after the bulk revoke (but before this
    // loop reaches it) must keep the signer attached, exactly like a sibling grant would.
    const signerResults: Record<string, boolean> = {};
    for (const walletId of walletIds) {
      const remaining = await countActiveDelegationsForWallet(
        authzDb,
        walletId,
      );
      signerResults[walletId] =
        remaining === 0
          ? await tryDetachSigner(authzDb, services.env, walletId)
          : false;
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
