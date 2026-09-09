/**
 * apps/agent OAuth client (specs/mcp-auth-remediation-plan.md CI section, tasks.md Phase 10):
 * the CI harness already holds a long-lived, non-rotating refresh token (minted once, by a
 * human, via `apps/gateway/scripts/bootstrap-ci-credential.ts`'s real authorization_code+PKCE
 * flow) and exchanges it for a short-lived access token before every run. This is the ONLY
 * grant type the harness uses - it never runs the interactive authorize/consent redirect
 * itself, so it does not implement the MCP SDK's `OAuthClientProvider` (that interface is for
 * a client that CAN show a user a login screen; this one cannot).
 */
export type CiTokenInput = {
  gatewayUrl: string;
  clientId: string;
  refreshToken: string;
  fetch?: typeof fetch;
};

export type CiAccessToken = {
  accessToken: string;
  expiresIn: number;
  scope: string;
};

type TokenErrorBody = { error?: unknown; error_description?: unknown };
type TokenSuccessBody = {
  access_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * `POST /oauth/token` with `grant_type=refresh_token` (OAuth 2.1 §4.3). The gateway's
 * pre-registered CI client has `refresh_rotation_disabled=true` (oauth/token.ts), so the same
 * `refreshToken` this function was given keeps working call after call - there is no rotated
 * value to persist back anywhere.
 */
export async function fetchCiAccessToken(
  input: CiTokenInput,
): Promise<CiAccessToken> {
  const fetchImpl = input.fetch ?? fetch;
  const tokenUrl = `${input.gatewayUrl.replace(/\/$/, "")}/oauth/token`;
  const response = await fetchImpl(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
      client_id: input.clientId,
      // RFC 8707: binds the access token's audience to this gateway's /mcp resource, matching
      // what was originally authorized (oauth/metadata.ts's `resource` = `${origin}/mcp`).
      resource: `${input.gatewayUrl.replace(/\/$/, "")}/mcp`,
    }),
  });
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const errorBody = (body ?? {}) as TokenErrorBody;
    const error = isNonEmptyString(errorBody.error)
      ? errorBody.error
      : "unknown_error";
    const description = isNonEmptyString(errorBody.error_description)
      ? `: ${errorBody.error_description}`
      : "";
    throw new Error(
      `/oauth/token refresh failed (${response.status} ${error}${description})`,
    );
  }
  const success = (body ?? {}) as TokenSuccessBody;
  if (!isNonEmptyString(success.access_token)) {
    throw new Error("/oauth/token response is missing a valid access_token");
  }
  if (typeof success.expires_in !== "number" || success.expires_in <= 0) {
    throw new Error("/oauth/token response is missing a valid expires_in");
  }
  if (!isNonEmptyString(success.scope)) {
    throw new Error("/oauth/token response is missing a valid scope");
  }
  return {
    accessToken: success.access_token,
    expiresIn: success.expires_in,
    scope: success.scope,
  };
}
