import { bytesToHex, type Hex, hexToBytes } from "viem";

/**
 * Gateway-signed short-lived claims (HMAC-SHA256). Used for the ownerSession credential
 * (gateway-api.md /owner/keygate step 8: carries accessEpochAtGrant so a later presentation
 * can be answered OWNER_EPOCH_MISMATCH rather than NOT_CURRENT_OWNER) and for fallback
 * content grants. Claims are NEVER an authorization source - every release still re-reads
 * ownerOf / accessEpoch on chain (constitution II); they only select the error code.
 *
 * Token layout: 0x || utf8(JSON claims) || HMAC(32 bytes). The MAC key is derived from the
 * gateway signing secret with an HKDF info per purpose, so an owner-session token can never
 * be presented as a fallback grant.
 */
export type ClaimsPurpose = "owner-session" | "fallback-grant" | "mcp-session";

const MAC_BYTES = 32;

/** Copies into a fresh ArrayBuffer-backed view (Web Crypto rejects SharedArrayBuffer views). */
function owned(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes);
}

async function macKey(secret: Uint8Array, purpose: ClaimsPurpose) {
  const base = await crypto.subtle.importKey(
    "raw",
    owned(secret),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(`truenft/${purpose}/v1`),
    },
    base,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign", "verify"],
  );
}

export async function signClaims<T extends { expiresAt: number }>(
  secret: Uint8Array,
  purpose: ClaimsPurpose,
  claims: T,
): Promise<Hex> {
  const payload = new TextEncoder().encode(JSON.stringify(claims));
  const key = await macKey(secret, purpose);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, payload));
  const out = new Uint8Array(payload.length + mac.length);
  out.set(payload, 0);
  out.set(mac, payload.length);
  return bytesToHex(out);
}

/** Returns the claims when the MAC verifies and the token has not expired; undefined otherwise. */
export async function verifyClaims<T extends { expiresAt: number }>(
  secret: Uint8Array,
  purpose: ClaimsPurpose,
  token: string,
  nowSec: number,
): Promise<T | undefined> {
  if (!/^0x[0-9a-fA-F]+$/.test(token) || token.length % 2 !== 0) {
    return undefined;
  }
  const bytes = hexToBytes(token as Hex);
  if (bytes.length <= MAC_BYTES) return undefined;
  const payload = owned(bytes.slice(0, bytes.length - MAC_BYTES));
  const mac = owned(bytes.slice(bytes.length - MAC_BYTES));
  const key = await macKey(secret, purpose);
  const ok = await crypto.subtle.verify("HMAC", key, mac, payload);
  if (!ok) return undefined;
  let claims: T;
  try {
    claims = JSON.parse(new TextDecoder().decode(payload)) as T;
  } catch {
    return undefined;
  }
  if (typeof claims.expiresAt !== "number" || claims.expiresAt <= nowSec) {
    return undefined;
  }
  return claims;
}

export type OwnerSessionClaims = {
  assetId: Hex;
  wallet: Hex;
  /** decimal string (bigint) */
  accessEpochAtGrant: string;
  expiresAt: number;
};
