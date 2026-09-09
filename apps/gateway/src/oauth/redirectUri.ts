/**
 * Redirect URI validation (OAuth 2.1 §4.1.3 / RFC 8252 §7.3): a redirect_uri must be an exact
 * match against one of the client's registered URIs - no prefix/subdomain/query matching,
 * which is exactly the class of bug that lets an attacker redirect an authorization code to a
 * host they control. Registration itself only restricts which *schemes/hosts* a client may
 * register (https:, or loopback http: for native apps) - it does not, and cannot, vet who
 * actually controls a given https: host. A client can still register `https://attacker.example`
 * with a trustworthy-looking name; the follow-up consent screen (Phase 9) is what must show
 * the user the real redirect destination before they approve anything, not this module.
 */
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "[::1]", "localhost"]);

function isLoopbackHttp(url: URL): boolean {
  return url.protocol === "http:" && LOOPBACK_HOSTNAMES.has(url.hostname);
}

/** Byte-for-byte match, except: for a *registered* loopback http: URI, the port may differ
 * (RFC 8252 §7.3 - a native app obtains an ephemeral port from the OS at request time, so the
 * authorization server "MUST allow any port to be specified... for loopback IP redirect
 * URIs"). Every other case (https:, non-loopback http:, differing scheme/host/path) is exact. */
export function isRegisteredRedirectUri(
  registeredUris: readonly string[],
  candidate: string,
): boolean {
  if (registeredUris.includes(candidate)) return true;
  let candidateUrl: URL;
  try {
    candidateUrl = new URL(candidate);
  } catch {
    return false;
  }
  if (!isLoopbackHttp(candidateUrl)) return false;
  return registeredUris.some((registered) => {
    let registeredUrl: URL;
    try {
      registeredUrl = new URL(registered);
    } catch {
      return false;
    }
    return (
      isLoopbackHttp(registeredUrl) &&
      registeredUrl.hostname === candidateUrl.hostname &&
      registeredUrl.pathname === candidateUrl.pathname &&
      registeredUrl.search === candidateUrl.search
    );
  });
}

/**
 * Registration-time validation (RFC 8252 native-app redirect URIs): every URI must parse as
 * absolute with no fragment (RFC 6749 §3.1.2 - a redirect_uri "MUST NOT include a fragment
 * component"), and must be either `https:`, or a loopback interface over `http:` (127.0.0.1 /
 * [::1] / localhost - native apps and CLIs redirecting to a locally-bound listener). Anything
 * else (plain `http:` to a non-loopback host, a non-URL string, a custom scheme without a
 * host) is rejected at registration so a malicious DCR request can't register a redirect
 * target this server would otherwise treat as a loopback exception.
 */
export function isAllowedRedirectUriForRegistration(
  candidate: string,
): boolean {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return false;
  }
  if (url.hash !== "") return false;
  if (url.protocol === "https:") return true;
  return isLoopbackHttp(url);
}
