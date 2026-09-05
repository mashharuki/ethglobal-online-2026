import { type Hex, hexToBytes } from "viem";
import { deriveShareUInfo } from "./manifest";

/**
 * KeyGate 2-of-2 share arithmetic (research.md R-1 / R-1a, contracts/eip712-types.md):
 *   K        = share_G XOR share_U
 *   mask     = HKDF-SHA256(ikm = sig_wallet, salt = "", info = "truenft/keygate/v1/<assetId>", 32 bytes)
 *   blindedU = share_U XOR mask          (computed once by the gateway, stored per wallet)
 *   share_U' = blindedU XOR mask         (recomputed by the client from its own signature)
 * `sig_wallet` is the deterministic signature over the FIXED KeyGateChallenge; it is key
 * material only and is never used to authenticate a request (R-1a). This module is shared by
 * the gateway (blinding), the web viewer and the agent (unblinding) so the derivation can
 * never drift. Web Crypto only.
 */
export const SHARE_BYTES = 32;
const HKDF_OUTPUT_BITS = SHARE_BYTES * 8;

type HkdfKey = object;
type WebCrypto = {
  subtle: {
    importKey(
      format: "raw",
      keyData: Uint8Array,
      algorithm: "HKDF",
      extractable: boolean,
      keyUsages: string[],
    ): Promise<HkdfKey>;
    deriveBits(
      algorithm: {
        name: "HKDF";
        hash: "SHA-256";
        salt: Uint8Array;
        info: Uint8Array;
      },
      baseKey: HkdfKey,
      length: number,
    ): Promise<ArrayBuffer>;
  };
};

function webCrypto(): WebCrypto {
  const api = (globalThis as { crypto?: WebCrypto }).crypto;
  if (api?.subtle === undefined)
    throw new Error("Web Crypto (crypto.subtle) is not available");
  return api;
}

export function xorBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length !== b.length) throw new RangeError("xor: length mismatch");
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i += 1) out[i] = (a[i] ?? 0) ^ (b[i] ?? 0);
  return out;
}

function assertShare(name: string, bytes: Uint8Array): void {
  if (bytes.length !== SHARE_BYTES) {
    throw new RangeError(`${name} must be ${SHARE_BYTES} bytes`);
  }
}

/** HKDF-SHA256 mask bound to the wallet's KeyGateChallenge signature and the assetId. */
export async function deriveBlindingMask(
  keyGateSig: Hex,
  assetId: Hex,
): Promise<Uint8Array> {
  const ikm = Uint8Array.from(hexToBytes(keyGateSig));
  if (ikm.length !== 65) {
    throw new RangeError("keyGateSig must be a 65-byte secp256k1 signature");
  }
  const { subtle } = webCrypto();
  const key = await subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: Uint8Array.from(
        new TextEncoder().encode(deriveShareUInfo(assetId)),
      ),
    },
    key,
    HKDF_OUTPUT_BITS,
  );
  ikm.fill(0);
  return new Uint8Array(bits);
}

/** Gateway side (first access only): blindedU = share_U XOR mask. */
export async function blindShareU(
  shareU: Uint8Array,
  keyGateSig: Hex,
  assetId: Hex,
): Promise<Uint8Array> {
  assertShare("share_U", shareU);
  const mask = await deriveBlindingMask(keyGateSig, assetId);
  const out = xorBytes(shareU, mask);
  mask.fill(0);
  return out;
}

/** Client side: share_U' = blindedU XOR mask (never touches the gateway). */
export async function unblindShareU(
  blindedU: Uint8Array,
  keyGateSig: Hex,
  assetId: Hex,
): Promise<Uint8Array> {
  assertShare("blindedU", blindedU);
  const mask = await deriveBlindingMask(keyGateSig, assetId);
  const out = xorBytes(blindedU, mask);
  mask.fill(0);
  return out;
}

/** K = share_G XOR share_U (client side, or the disclosed fallback path on the gateway). */
export function recoverContentKey(
  shareG: Uint8Array,
  shareU: Uint8Array,
): Uint8Array {
  assertShare("share_G", shareG);
  assertShare("share_U", shareU);
  return xorBytes(shareG, shareU);
}
