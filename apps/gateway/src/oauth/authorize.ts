import { oauthAuthorizationRequest } from "../db/schema";
import type { AuthzDb } from "../db/types";
import { AppError } from "../errors";
import { assertClientUsable } from "./clients";
import { buildProtectedResourceMetadata, SCOPES_SUPPORTED } from "./metadata";
import { isRegisteredRedirectUri } from "./redirectUri";
import { generateOpaqueValue, hashOpaqueValue } from "./tokenHash";

/**
 * /oauth/authorize (OAuth 2.1 §4.1.1, specs/mcp-auth-remediation-plan.md §6). client_id and
 * redirect_uri must be validated TOGETHER, and validated first, before any other error can be
 * reported: an unregistered redirect_uri can't be trusted to receive an error redirect (that's
 * exactly the "open redirect via error response" class of OAuth bug). Every failure after that
 * point is safe to report back to the client's own redirect_uri as an OAuth error response
 * (RFC 6749 §4.1.2.1), never as a direct HTTP error - `AuthorizeOutcome`'s two variants are
 * this split made explicit in the type.
 */
export const AUTHORIZATION_REQUEST_TTL_SEC = 10 * 60;

export type AuthorizeInput = {
  clientId: string;
  redirectUri: string;
  scope: string;
  resource: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  state: string | null;
};

export type AuthorizeOutcome =
  | { kind: "redirect_to_consent"; requestId: string }
  | {
      kind: "redirect_with_error";
      redirectUri: string;
      error: string;
      errorDescription: string;
      state: string | null;
    };

export async function beginAuthorization(
  db: AuthzDb,
  origin: string,
  input: AuthorizeInput,
  now: Date,
): Promise<AuthorizeOutcome> {
  // client_id + redirect_uri validated together, first - a failure here is shown directly
  // (the route handler answers 400, it does NOT construct a redirect from unvalidated input).
  // assertClientUsable already throws AppError("CONSENT_REQUEST_INVALID", ...) for an
  // unknown/disabled client - let it propagate as-is.
  const client = await assertClientUsable(db, input.clientId);
  if (!isRegisteredRedirectUri(client.redirectUris, input.redirectUri)) {
    throw new AppError(
      "CONSENT_REQUEST_INVALID",
      "redirect_uri is not registered for this client",
    );
  }

  const redirectError = (
    error: string,
    errorDescription: string,
  ): AuthorizeOutcome => ({
    kind: "redirect_with_error",
    redirectUri: input.redirectUri,
    error,
    errorDescription,
    state: input.state,
  });

  if (input.codeChallengeMethod !== "S256") {
    return redirectError(
      "invalid_request",
      "code_challenge_method must be S256 (plain is not supported)",
    );
  }
  if (input.codeChallenge.length === 0) {
    return redirectError("invalid_request", "code_challenge is required");
  }
  const requestedScopes = input.scope.split(" ").filter((s) => s.length > 0);
  if (
    requestedScopes.length === 0 ||
    !requestedScopes.every((s) => SCOPES_SUPPORTED.includes(s))
  ) {
    return redirectError(
      "invalid_scope",
      `scope must be a non-empty subset of: ${SCOPES_SUPPORTED.join(" ")}`,
    );
  }
  const expectedResource = buildProtectedResourceMetadata(origin).resource;
  if (input.resource !== expectedResource) {
    return redirectError(
      "invalid_target",
      `resource must be ${expectedResource}`,
    );
  }

  const requestId = generateOpaqueValue();
  await db.insert(oauthAuthorizationRequest).values({
    requestIdHash: hashOpaqueValue(requestId),
    clientId: input.clientId,
    redirectUri: input.redirectUri,
    codeChallenge: input.codeChallenge,
    codeChallengeMethod: input.codeChallengeMethod,
    scope: input.scope,
    resource: input.resource,
    state: input.state,
    expiresAt: new Date(now.getTime() + AUTHORIZATION_REQUEST_TTL_SEC * 1000),
  });
  return { kind: "redirect_to_consent", requestId };
}
