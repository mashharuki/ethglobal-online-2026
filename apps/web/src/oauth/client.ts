import { toGatewayError } from "../api/client";

/**
 * `/oauth/consent` client (Phase 9): plain `fetch()`, not the typed `openapi-fetch` client in
 * ../api/client.ts - OAuth routes are deliberately excluded from packages/openapi/openapi.yaml
 * (the same choice every earlier OAuth phase this session made), and this endpoint is
 * authenticated by a Privy access token, never the gateway's own session/wallet flow the
 * typed client's other calls use.
 */
export type ConsentDetails = {
  clientId: string;
  clientName: string;
  scope: string;
  resource: string;
  expiresAt: string;
};

async function parseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

/**
 * A malformed-but-2xx response must fail loudly, not coerce into a plausible-looking string
 * (Codex review: `String(undefined)` silently becomes the literal text "undefined", which
 * `submitConsentDecision`'s caller would otherwise navigate `window.location.href` to instead
 * of surfacing an error).
 */
function requireStringField(
  record: Record<string, unknown>,
  key: string,
): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`gateway response is missing a valid "${key}" field`);
  }
  return value;
}

export async function fetchConsentDetails(
  gatewayUrl: string,
  accessToken: string,
  requestId: string,
  /** test-only: stub the gateway at the HTTP boundary instead of mocking this module. */
  fetchImpl: typeof fetch = fetch,
): Promise<ConsentDetails> {
  const url = new URL("/oauth/consent", gatewayUrl);
  url.searchParams.set("request_id", requestId);
  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const body = await parseJson(response);
  if (!response.ok) throw toGatewayError(response.status, body);
  const record = (
    typeof body === "object" && body !== null ? body : {}
  ) as Record<string, unknown>;
  return {
    clientId: requireStringField(record, "client_id"),
    clientName: requireStringField(record, "client_name"),
    scope: requireStringField(record, "scope"),
    resource: requireStringField(record, "resource"),
    expiresAt: requireStringField(record, "expires_at"),
  };
}

export async function submitConsentDecision(
  gatewayUrl: string,
  accessToken: string,
  requestId: string,
  decision: "allow" | "deny",
  /** test-only: stub the gateway at the HTTP boundary instead of mocking this module. */
  fetchImpl: typeof fetch = fetch,
): Promise<{ redirectUri: string }> {
  const response = await fetchImpl(new URL("/oauth/consent", gatewayUrl), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ request_id: requestId, decision }),
  });
  const body = await parseJson(response);
  if (!response.ok) throw toGatewayError(response.status, body);
  const record = (
    typeof body === "object" && body !== null ? body : {}
  ) as Record<string, unknown>;
  return { redirectUri: requireStringField(record, "redirect_uri") };
}
