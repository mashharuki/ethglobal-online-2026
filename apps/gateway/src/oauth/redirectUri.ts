/**
 * Redirect URI validation (OAuth 2.1 §4.1.3 / RFC 8252 §7.3): a redirect_uri must be an exact,
 * byte-for-byte match against one of the client's registered URIs - no prefix/subdomain/query
 * matching, which is exactly the class of bug that lets an attacker redirect an authorization
 * code to a host they control. Registration itself (clients.ts) is what actually restricts
 * which schemes/hosts a client may register in the first place; this module only re-checks an
 * incoming request against what was already registered.
 */
export function isRegisteredRedirectUri(
  registeredUris: readonly string[],
  candidate: string,
): boolean {
  return registeredUris.includes(candidate);
}

/**
 * Registration-time validation (RFC 8252 native-app redirect URIs): every URI must parse as
 * absolute, and must be either `https:`, or a loopback interface over `http:` (127.0.0.1 /
 * [::1] / localhost - native apps and CLIs redirecting to a locally-bound listener). Anything
 * else (plain `http:` to a non-loopback host, a non-URL string, a custom scheme without a
 * host) is rejected at registration so a malicious DCR request can't register an
 * attacker-controlled redirect target.
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
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") {
    return (
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]" ||
      url.hostname === "localhost"
    );
  }
  return false;
}
