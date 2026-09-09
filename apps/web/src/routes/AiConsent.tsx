import { usePrivy } from "@privy-io/react-auth";
import { useCallback, useEffect, useRef, useState } from "react";
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

/**
 * Every load result is tagged with the request_id it was fetched FOR - never a bare
 * details/error pair. Whether a tagged result is safe to ACT ON (render, enable Allow/Deny)
 * is decided at render time by comparing it against `requestId` read fresh from the URL, not
 * against anything an earlier async callback happened to see - so a stale response can still
 * land in `loadState` (see the `latestRequestId` guard below for why that's rare, not why it's
 * safe), but it can never be the one that's read (Codex review round 1: a ref-based guard used
 * to gate RENDERING directly had a timing window between `requestId` changing and the new
 * `load()` call actually starting).
 */
type LoadState =
  | { kind: "loaded"; requestId: string; details: ConsentDetails }
  | { kind: "error"; requestId: string; error: unknown };

export default function AiConsent() {
  const { getAccessToken } = usePrivy();
  const [searchParams] = useSearchParams();
  const requestId = searchParams.get("request_id");
  const [loadState, setLoadState] = useState<LoadState | undefined>();
  const [submitting, setSubmitting] = useState(false);
  // Best-effort ONLY (see the type doc above): avoids a slow, now-superseded load() clobbering
  // a faster, already-rendered CURRENT result with stale data and leaving the screen stuck on
  // "loading" (Codex review round 2: the render-time guard alone prevents ever SHOWING wrong
  // data, but a stale write landing after a correct one still overwrote it with nothing then
  // re-fetching it). If this check ever loses its own narrow race, the worst case is exactly
  // that same "stuck loading" state, not a correctness/security regression - the render guard
  // above is unconditional and independent of this ref's timing.
  const latestRequestId = useRef<string | null>(null);

  const load = useCallback(async () => {
    if (requestId === null) return;
    const forRequestId = requestId;
    latestRequestId.current = forRequestId;
    try {
      const accessToken = await getAccessToken();
      if (accessToken === null) throw new Error("not logged in to Privy");
      const details = await fetchConsentDetails(
        getConfig().gatewayUrl,
        accessToken,
        forRequestId,
      );
      if (latestRequestId.current !== forRequestId) return;
      setLoadState({ kind: "loaded", requestId: forRequestId, details });
    } catch (e) {
      if (latestRequestId.current !== forRequestId) return;
      setLoadState({ kind: "error", requestId: forRequestId, error: e });
    }
  }, [requestId, getAccessToken]);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = useCallback(
    async (decision: "allow" | "deny") => {
      if (requestId === null) return;
      const forRequestId = requestId;
      setSubmitting(true);
      try {
        const accessToken = await getAccessToken();
        if (accessToken === null) throw new Error("not logged in to Privy");
        const { redirectUri } = await submitConsentDecision(
          getConfig().gatewayUrl,
          accessToken,
          forRequestId,
          decision,
        );
        window.location.href = redirectUri;
      } catch (e) {
        // Same best-effort stale-write guard as load() (Codex review round 3: this catch
        // wrote unconditionally, so a decision submitted for a since-superseded request could
        // still clobber a newer, already-rendered valid result on its way out).
        if (latestRequestId.current === forRequestId) {
          setLoadState({ kind: "error", requestId: forRequestId, error: e });
        }
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

  // Only ever act on a result that belongs to THIS request_id, read fresh from the URL on
  // every render - a stale response for a superseded request may still be sitting in
  // `loadState`, but it will never match here.
  const current = loadState?.requestId === requestId ? loadState : undefined;
  const details = current?.kind === "loaded" ? current.details : undefined;
  const error = current?.kind === "error" ? current.error : undefined;

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
