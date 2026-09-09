import { and, eq } from "drizzle-orm";
import {
  oauthAuthorizationCode,
  oauthAuthorizationRequest,
} from "../db/schema";
import type { AuthzDb } from "../db/types";
import type { Env } from "../env";
import { AppError } from "../errors";
import { createGrant, resolveActiveDelegationForClient } from "../mcp/grant";
import type { PrivyDelegationEnv } from "../mcp/privyClient";
import { provisionAgentWallet } from "../mcp/walletProvisioning";
import { resolveClient } from "./clients";
import { generateOpaqueValue, hashOpaqueValue } from "./tokenHash";

/**
 * POST /oauth/consent (specs/mcp-auth-remediation-plan.md §3/§6, tasks.md Phase 9): the step
 * `beginAuthorization` (oauth/authorize.ts) defers to the web "AI access" screen. The caller's
 * identity here is a Privy access token verified by mcp/privyClient.ts's
 * `verifyPrincipalAccessToken` (routes/oauth.ts does that before calling this module) - NOT
 * this gateway's own OAuth Bearer tokens, which don't exist yet at this point in the flow.
 *
 * Wallet provisioning (an external Privy API call) happens OUTSIDE any DB transaction - it
 * isn't rollback-able and shouldn't hold a DB connection open across a slow network call
 * (same reasoning as walletProvisioning.ts's own multi-step state machine). Only the final
 * "consume the request, mint the code" step is wrapped in `db.transaction()`, so a failure
 * between those two writes can never leave the request `consented` with no code ever issued.
 */
const AUTHORIZATION_CODE_TTL_SEC = 5 * 60;

type ConsentDecision = "allow" | "deny";

export type ConsentInput = {
  requestId: string;
  principalId: string;
  decision: ConsentDecision;
  chainId: number;
};

export type ConsentResult = { redirectUri: string };

type PendingRequest = typeof oauthAuthorizationRequest.$inferSelect;

/** Shared by `getConsentRequestDetails` (read, for the consent screen to render) and
 * `resolveConsent` (write) - both need the identical "does this request still exist, is it
 * still pending, has it not expired" check, and must reject identically either way. */
async function resolvePendingRequest(
  db: AuthzDb,
  requestId: string,
  now: Date,
): Promise<{
  requestIdHash: ReturnType<typeof hashOpaqueValue>;
  request: PendingRequest;
}> {
  const requestIdHash = hashOpaqueValue(requestId);
  const [request] = await db
    .select()
    .from(oauthAuthorizationRequest)
    .where(eq(oauthAuthorizationRequest.requestIdHash, requestIdHash))
    .limit(1);
  if (
    request === undefined ||
    request.status !== "pending" ||
    request.expiresAt <= now
  ) {
    throw new AppError(
      "CONSENT_REQUEST_INVALID",
      "unknown, already-resolved, or expired consent request",
    );
  }
  return { requestIdHash, request };
}

export type ConsentRequestDetails = {
  clientId: string;
  clientName: string;
  scope: string;
  resource: string;
  expiresAt: Date;
};

/** GET /oauth/consent (routes/oauth.ts): what the consent screen renders BEFORE the user
 * decides - which client is asking, for what scope, expiring when. Read-only; does not
 * consume the request (only `resolveConsent`, below, does that). */
export async function getConsentRequestDetails(
  db: AuthzDb,
  requestId: string,
  now: Date,
): Promise<ConsentRequestDetails> {
  const { request } = await resolvePendingRequest(db, requestId, now);
  const client = await resolveClient(db, request.clientId);
  return {
    clientId: request.clientId,
    clientName: client?.clientName ?? "Unnamed client",
    scope: request.scope,
    resource: request.resource,
    expiresAt: request.expiresAt,
  };
}

export async function resolveConsent(
  db: AuthzDb,
  grantEnv: Pick<
    Env,
    | "MCP_GRANT_DEFAULT_TOTAL_BUDGET_TINYBAR"
    | "MCP_GRANT_DEFAULT_MAX_PER_PURCHASE_TINYBAR"
    | "MCP_GRANT_DEFAULT_TTL_SEC"
  >,
  delegationEnv: PrivyDelegationEnv,
  input: ConsentInput,
  now: Date,
  /** test-only: stub Privy at the HTTP boundary instead of mocking this module. */
  fetchImpl?: typeof fetch,
): Promise<ConsentResult> {
  const { requestIdHash, request } = await resolvePendingRequest(
    db,
    input.requestId,
    now,
  );

  const redirectUrl = new URL(request.redirectUri);
  if (request.state !== null)
    redirectUrl.searchParams.set("state", request.state);

  if (input.decision === "deny") {
    const [denied] = await db
      .update(oauthAuthorizationRequest)
      .set({
        status: "denied",
        principalId: input.principalId,
        consumedAt: now,
      })
      .where(
        and(
          eq(oauthAuthorizationRequest.requestIdHash, requestIdHash),
          eq(oauthAuthorizationRequest.status, "pending"),
        ),
      )
      .returning({ requestIdHash: oauthAuthorizationRequest.requestIdHash });
    if (denied === undefined) {
      throw new AppError(
        "CONSENT_REQUEST_INVALID",
        "consent request was already resolved",
      );
    }
    redirectUrl.searchParams.set("error", "access_denied");
    redirectUrl.searchParams.set(
      "error_description",
      "the user declined to grant access",
    );
    return { redirectUri: redirectUrl.toString() };
  }

  // Re-approving an already-connected client reuses its existing live grant (and budget/spend
  // history) rather than attempting a second createGrant, which
  // agent_grant_live_principal_client_uniq (schema.ts) would reject anyway.
  const existingGrant = await resolveActiveDelegationForClient(
    db,
    input.principalId,
    request.clientId,
  );
  const grant =
    existingGrant ??
    (await createGrant(db, grantEnv, {
      principalId: input.principalId,
      walletId: (
        await provisionAgentWallet(
          db,
          delegationEnv,
          { principalId: input.principalId, chainId: input.chainId },
          fetchImpl,
        )
      ).id,
      clientId: request.clientId,
      scope: request.scope,
      chainId: input.chainId,
      now,
    }));

  // The WHERE-status='pending' CAS below is what serializes two concurrent resolveConsent
  // calls for the same request (the row lock this UPDATE takes is held until commit, so a
  // second racer's own UPDATE cannot proceed until this one has already committed) - the
  // request-status check at the top of this function alone only rejects a SEQUENTIAL replay
  // (a request that's already `consented`/`denied` by the time a later call reads it), which
  // is all a single-connection PGlite test can exercise. Positive-controlling the CAS's own
  // race-serialization (not just this sequential-replay behavior) needs two connections
  // racing on the same row - a real-Postgres concurrency test, tracked as a Phase 11 item this
  // session has repeatedly deferred (specs/mcp-auth-remediation-plan.md), not something this
  // PGlite-backed suite can exercise; do not read the passing tests here as having verified
  // that race.
  const code = generateOpaqueValue();
  await db.transaction(async (tx) => {
    const authzTx = tx as unknown as AuthzDb;
    const [consented] = await authzTx
      .update(oauthAuthorizationRequest)
      .set({
        status: "consented",
        principalId: input.principalId,
        consumedAt: now,
      })
      .where(
        and(
          eq(oauthAuthorizationRequest.requestIdHash, requestIdHash),
          eq(oauthAuthorizationRequest.status, "pending"),
        ),
      )
      .returning({ requestIdHash: oauthAuthorizationRequest.requestIdHash });
    if (consented === undefined) {
      throw new AppError(
        "CONSENT_REQUEST_INVALID",
        "consent request was already resolved",
      );
    }
    // oauth_authorization_code_request_unique (schema.ts) is the DB-enforced backstop: even if
    // the CAS above were ever raced past, only one code could ever be inserted per request.
    await authzTx.insert(oauthAuthorizationCode).values({
      codeHash: hashOpaqueValue(code),
      requestIdHash,
      clientId: request.clientId,
      principalId: input.principalId,
      grantId: grant.id,
      redirectUri: request.redirectUri,
      codeChallenge: request.codeChallenge,
      scope: request.scope,
      resource: request.resource,
      expiresAt: new Date(now.getTime() + AUTHORIZATION_CODE_TTL_SEC * 1000),
    });
  });

  redirectUrl.searchParams.set("code", code);
  return { redirectUri: redirectUrl.toString() };
}
