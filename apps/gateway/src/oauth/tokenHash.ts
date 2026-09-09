import { type Hex, keccak256, stringToHex } from "viem";

/**
 * Opaque bearer-value generation and hashing (OAuth 2.1 authorization server,
 * specs/mcp-auth-remediation-plan.md §6). Every bearer value this module mints (request_id,
 * authorization code, access/refresh token) is a high-entropy random string handed to the
 * client verbatim; the DB never stores that string, only its `keccak256(stringToHex(value))`
 * hash (mcp/session.ts's existing convention for `mcp_session_binding.session_key`) - a
 * database leak alone can't be replayed as a live credential.
 */

/** 256 bits of randomness, base64url-encoded (no padding) - URL-safe and long enough that
 * guessing is infeasible. */
export function generateOpaqueValue(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export function hashOpaqueValue(value: string): Hex {
  return keccak256(stringToHex(value));
}

/** RFC 7636 §4.1: `code-verifier = 43*128unreserved`, `unreserved = ALPHA / DIGIT / "-" / "."
 * / "_" / "~"`. Rejecting anything outside this shape before hashing (Codex review) means an
 * empty, oversized, or non-ASCII verifier is refused outright rather than silently hashed and
 * compared - a shape no compliant client would ever send in the first place. */
const CODE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;

/**
 * PKCE S256 verification (RFC 7636 §4.6). This MUST be literal SHA-256, not this codebase's
 * usual keccak256 - every real OAuth client library computes `code_challenge` as
 * BASE64URL(SHA256(code_verifier)), so substituting a different hash would make every client
 * fail PKCE against this server.
 */
export async function verifyPkceS256(
  codeVerifier: string,
  codeChallenge: string,
): Promise<boolean> {
  if (!CODE_VERIFIER_PATTERN.test(codeVerifier)) return false;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(codeVerifier),
  );
  const bytes = new Uint8Array(digest);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const computed = btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  return timingSafeEqual(computed, codeChallenge);
}

/** String comparison in constant time relative to the shorter input - a PKCE/token compare
 * must not leak how many leading characters matched via response timing. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
