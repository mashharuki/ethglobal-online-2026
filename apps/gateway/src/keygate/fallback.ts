import { recoverContentKey } from "@truenft/shared";
import type { Address, Hex } from "viem";
import { signClaims, verifyClaims } from "../auth/session";
import type { Env } from "../env";
import { loadShareG } from "../kv/shareStore";
import { readReceiptSignerSecret, readShareU, wipe } from "./vault";

/**
 * Fallback release path (tasks.md T077 (2), research.md R-1 "フォールバック"): after the
 * SAME authorization decision as the KeyGate path (keygate/release.ts), the gateway hands out
 * a short-lived grant and decrypts the content itself. In this mode the gateway reconstructs
 * the full content key K = share_G XOR share_U, i.e. it handles plaintext - a documented
 * deviation from constitution VI (plan.md Complexity Tracking, README T125). It exists so the
 * encrypted-content demo always works even if the client-side unblinding is not ready.
 */
const FALLBACK_GRANT_TTL_SEC = 300;

export type FallbackGrantClaims = {
  assetId: Hex;
  wallet: Hex;
  path: "owner" | "licensee";
  expiresAt: number;
};

// the receipt signer key doubles as the HMAC root; purpose-specific HKDF keeps it separate
const grantSecret = readReceiptSignerSecret;

export async function issueFallbackGrant(
  env: Env,
  input: {
    assetId: Hex;
    wallet: Address;
    path: "owner" | "licensee";
    nowSec: number;
  },
): Promise<{ token: Hex; expiresAt: number }> {
  const expiresAt = input.nowSec + FALLBACK_GRANT_TTL_SEC;
  const secret = grantSecret(env);
  try {
    const token = await signClaims<FallbackGrantClaims>(
      secret,
      "fallback-grant",
      {
        assetId: input.assetId,
        wallet: input.wallet,
        path: input.path,
        expiresAt,
      },
    );
    return { token, expiresAt };
  } finally {
    wipe(secret);
  }
}

/** undefined = invalid, expired, or issued for another asset. */
export async function verifyFallbackGrant(
  env: Env,
  token: string,
  assetId: Hex,
  nowSec: number,
): Promise<FallbackGrantClaims | undefined> {
  const secret = grantSecret(env);
  try {
    const claims = await verifyClaims<FallbackGrantClaims>(
      secret,
      "fallback-grant",
      token,
      nowSec,
    );
    if (claims === undefined) return undefined;
    if (claims.assetId.toLowerCase() !== assetId.toLowerCase())
      return undefined;
    return claims;
  } finally {
    wipe(secret);
  }
}

/** iv (12) || ciphertext || tag - the layout apps/contracts seed encrypts with. */
export async function decryptWithKey(
  key: Uint8Array,
  blob: Uint8Array,
): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(key),
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  const iv = new Uint8Array(blob.slice(0, 12));
  const ciphertext = new Uint8Array(blob.slice(12));
  return new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv }, cryptoKey, ciphertext),
  );
}

/**
 * Gateway-side decryption (fallback only). Reconstructs K from both shares, decrypts, and
 * wipes every key byte before returning. Callers must have passed keygate/release first.
 */
export async function fallbackDecrypt(
  env: Env,
  assetId: Hex,
  encryptedContent: Uint8Array,
): Promise<Uint8Array> {
  const shareG = await loadShareG(env, assetId);
  const shareU = readShareU(env, assetId);
  const key = recoverContentKey(shareG, shareU);
  wipe(shareG);
  wipe(shareU);
  try {
    return await decryptWithKey(key, encryptedContent);
  } finally {
    wipe(key);
  }
}
