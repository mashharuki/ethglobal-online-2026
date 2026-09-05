import { bytesToHex, type Hex, hexToBytes } from "viem";

/**
 * share_G at-rest format for Workers KV (FR-016). The seed loader (apps/contracts
 * scripts -> apps/gateway/scripts/load-shares.ts) and the gateway reader
 * (apps/gateway/src/kv/shareStore.ts) both import THIS module so the ciphertext layout
 * can never drift between writer and reader.
 *
 * Layout: `tc-kv-v1:<iv hex (12 bytes)>:<ciphertext||tag hex>` using AES-256-GCM.
 * The AAD binds the version AND the assetId (the KV key) so a blob encrypted for one
 * asset cannot be swapped into another asset's KV record under the same KEK.
 * Web Crypto only (Workers/browser/Node).
 */
export const KV_FORMAT_VERSION = "tc-kv-v1";
const IV_BYTES = 12;
const KEK_BYTES = 32;

// Structural types so this module typechecks against both DOM lib and @types/node (webcrypto).
type SubtleApi = typeof globalThis.crypto.subtle;
type AesKey = Awaited<ReturnType<SubtleApi["importKey"]>>;

function subtle(): SubtleApi {
  const api = globalThis.crypto?.subtle;
  if (api === undefined)
    throw new Error("Web Crypto (crypto.subtle) is not available");
  return api;
}

async function importKek(kek: Uint8Array): Promise<AesKey> {
  if (kek.length !== KEK_BYTES)
    throw new RangeError(`KEK must be ${KEK_BYTES} bytes`);
  return subtle().importKey(
    "raw",
    Uint8Array.from(kek),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

/** KV key for an asset's share_G record; also the AAD binding. */
export function shareGKvKey(assetId: Hex): string {
  return `share_g:${assetId.toLowerCase()}`;
}

function aadFor(assetId: Hex): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(
    new TextEncoder().encode(`${KV_FORMAT_VERSION}|${shareGKvKey(assetId)}`),
  );
}

export async function encryptShareG(
  shareG: Uint8Array,
  kek: Uint8Array,
  assetId: Hex,
): Promise<string> {
  const key = await importKek(kek);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await subtle().encrypt(
    { name: "AES-GCM", iv, additionalData: aadFor(assetId) },
    key,
    Uint8Array.from(shareG),
  );
  return `${KV_FORMAT_VERSION}:${bytesToHex(iv).slice(2)}:${bytesToHex(new Uint8Array(ciphertext)).slice(2)}`;
}

export class KvFormatError extends Error {
  override readonly name = "KvFormatError";
}

export async function decryptShareG(
  blob: string,
  kek: Uint8Array,
  assetId: Hex,
): Promise<Uint8Array> {
  const parts = blob.split(":");
  if (parts.length !== 3 || parts[0] !== KV_FORMAT_VERSION) {
    throw new KvFormatError(
      `unsupported share_G blob format (expected ${KV_FORMAT_VERSION})`,
    );
  }
  const [, ivHex = "", ctHex = ""] = parts;
  if (
    !/^[0-9a-f]{24}$/.test(ivHex) ||
    !/^[0-9a-f]+$/.test(ctHex) ||
    ctHex.length % 2 !== 0
  ) {
    throw new KvFormatError("malformed share_G blob");
  }
  const key = await importKek(kek);
  try {
    const plain = await subtle().decrypt(
      {
        name: "AES-GCM",
        iv: Uint8Array.from(hexToBytes(`0x${ivHex}`)),
        additionalData: aadFor(assetId),
      },
      key,
      Uint8Array.from(hexToBytes(`0x${ctHex}`)),
    );
    return new Uint8Array(plain);
  } catch {
    throw new KvFormatError(
      "share_G blob failed authentication (tampered, wrong KEK, or wrong asset)",
    );
  }
}
