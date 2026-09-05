import { webcrypto } from "node:crypto";
import { bytesToHex, type Hex, keccak256 } from "viem";

const subtle = webcrypto.subtle;

export function randomBytes(length: number): Uint8Array {
  return webcrypto.getRandomValues(new Uint8Array(length));
}

/** AES-256-GCM: returns iv || ciphertext||tag so the viewer can decrypt with the same K. */
export async function encryptContent(
  plaintext: Uint8Array,
  key: Uint8Array,
): Promise<Uint8Array> {
  const cryptoKey = await subtle.importKey(
    "raw",
    Uint8Array.from(key),
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const iv = randomBytes(12);
  const ciphertext = new Uint8Array(
    await subtle.encrypt(
      { name: "AES-GCM", iv },
      cryptoKey,
      Uint8Array.from(plaintext),
    ),
  );
  const out = new Uint8Array(iv.length + ciphertext.length);
  out.set(iv, 0);
  out.set(ciphertext, iv.length);
  return out;
}

export async function decryptContent(
  blob: Uint8Array,
  key: Uint8Array,
): Promise<Uint8Array> {
  const cryptoKey = await subtle.importKey(
    "raw",
    Uint8Array.from(key),
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  const iv = blob.slice(0, 12);
  const ciphertext = blob.slice(12);
  return new Uint8Array(
    await subtle.decrypt({ name: "AES-GCM", iv }, cryptoKey, ciphertext),
  );
}

/** KeyGate 2-share split: K = shareG XOR shareU (R-1). */
export function splitKey(key: Uint8Array): {
  shareG: Uint8Array;
  shareU: Uint8Array;
} {
  const shareG = randomBytes(key.length);
  const shareU = new Uint8Array(key.length);
  for (let i = 0; i < key.length; i++)
    shareU[i] = (key[i] ?? 0) ^ (shareG[i] ?? 0);
  return { shareG, shareU };
}

export function xorBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length !== b.length) throw new Error("xor: length mismatch");
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = (a[i] ?? 0) ^ (b[i] ?? 0);
  return out;
}

export function contentHashOf(ciphertext: Uint8Array): Hex {
  return keccak256(ciphertext);
}

export function toHex(bytes: Uint8Array): Hex {
  return bytesToHex(bytes);
}
