import { usePrivy } from "@privy-io/react-auth";
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import ErrorNote from "../components/ErrorNote";
import { getConfig } from "../config";
import {
  type ConsentDetails,
  fetchConsentDetails,
  submitConsentDecision,
} from "../oauth/client";

/**
 * /ai-consent (specs/mcp-auth-remediation-plan.md §3, tasks.md Phase 9): where
 * GET /oauth/authorize's 302 lands. Renders what the OAuth client (Claude Code, an MCP
 * client) is asking for, then POSTs the user's decision - the gateway's response carries the
 * redirect_uri that finishes the OAuth flow back at the client's own redirect_uri, which this
 * page navigates to directly (not a server-side redirect: this is a `fetch()`-driven SPA
 * screen, not a top-level navigation the whole way through).
 */
const SCOPE_DESCRIPTIONS: Record<string, string> = {
  "assets:read": "Discover which assets exist (no purchases, no data access)",
  "access:buy": "Buy paid access to assets using its own AI wallet's HBAR",
};

function describeScope(scope: string): string[] {
  return scope
    .split(" ")
    .filter((s) => s.length > 0)
    .map((s) => SCOPE_DESCRIPTIONS[s] ?? s);
}

export default function AiConsent() {
  const { getAccessToken } = usePrivy();
  const [searchParams] = useSearchParams();
  const requestId = searchParams.get("request_id");
  const [details, setDetails] = useState<ConsentDetails | undefined>();
  const [error, setError] = useState<unknown>();
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    if (requestId === null) return;
    setError(undefined);
    try {
      const accessToken = await getAccessToken();
      if (accessToken === null) throw new Error("not logged in to Privy");
      const details = await fetchConsentDetails(
        getConfig().gatewayUrl,
        accessToken,
        requestId,
      );
      setDetails(details);
    } catch (e) {
      setError(e);
    }
  }, [requestId, getAccessToken]);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = useCallback(
    async (decision: "allow" | "deny") => {
      if (requestId === null) return;
      setSubmitting(true);
      setError(undefined);
      try {
        const accessToken = await getAccessToken();
        if (accessToken === null) throw new Error("not logged in to Privy");
        const { redirectUri } = await submitConsentDecision(
          getConfig().gatewayUrl,
          accessToken,
          requestId,
          decision,
        );
        window.location.href = redirectUri;
      } catch (e) {
        setError(e);
        setSubmitting(false);
      }
    },
    [requestId, getAccessToken],
  );

  if (requestId === null) {
    return (
      <p className="card error" role="alert">
        request_id is missing from the URL - this page is only meant to be
        reached from an OAuth authorization redirect.
      </p>
    );
  }

  return (
    <div className="space-y-4 max-w-lg">
      <h2>AI access request</h2>
      {error !== undefined && <ErrorNote error={error} />}
      {details === undefined && error === undefined && <p>loading…</p>}
      {details !== undefined && (
        <div className="card space-y-3">
          <p>
            <strong>{details.clientName}</strong> wants to act on your behalf
            using a dedicated AI wallet.
          </p>
          <ul className="text-sm space-y-1">
            {describeScope(details.scope).map((line) => (
              <li key={line}>· {line}</li>
            ))}
          </ul>
          <p className="text-sm">
            A new Hedera Testnet wallet will be created for this AI agent,
            separate from your own wallet shown above. You control its spending
            budget and can revoke this access at any time from the Dashboard.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              className="btn primary"
              disabled={submitting}
              onClick={() => void decide("allow")}
            >
              Allow AI access
            </button>
            <button
              type="button"
              className="btn"
              disabled={submitting}
              onClick={() => void decide("deny")}
            >
              Deny
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
