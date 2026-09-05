import { recoverContentKey } from "@truenft/shared";
import { type Hex, hexToBytes, keccak256 } from "viem";

/**
 * K = share_G XOR share_U' -> AES-256-GCM (iv(12) || ciphertext || tag, the layout the seed
 * script writes) -> plaintext (tasks.md T107). The ciphertext is checked against the
 * manifest's contentHash before any key touches it.
 */
export type Dataset = {
  format: "json" | "csv" | "text" | "binary";
  text?: string;
  bytes: Uint8Array;
};

export class ContentHashMismatchError extends Error {
  override readonly name = "ContentHashMismatchError";
}

function assertContentHash(ciphertext: Uint8Array, contentHash: Hex): void {
  if (keccak256(ciphertext).toLowerCase() !== contentHash.toLowerCase()) {
    throw new ContentHashMismatchError(
      "encrypted content does not match the manifest contentHash",
    );
  }
}

async function decryptWithKey(
  key: Uint8Array,
  blob: Uint8Array,
): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key.slice(),
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  const iv = blob.slice(0, 12);
  const ciphertext = blob.slice(12);
  return new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv }, cryptoKey, ciphertext),
  );
}

export function describeDataset(bytes: Uint8Array): Dataset {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { format: "binary", bytes };
  }
  try {
    JSON.parse(text);
    return { format: "json", text, bytes };
  } catch {
    // not JSON
  }
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  return { format: firstLine.includes(",") ? "csv" : "text", text, bytes };
}

export async function decryptContent(input: {
  shareG: Hex;
  shareU: Uint8Array;
  ciphertext: Uint8Array;
  contentHash: Hex;
}): Promise<Dataset> {
  assertContentHash(input.ciphertext, input.contentHash);
  const shareG = hexToBytes(input.shareG);
  const key = recoverContentKey(shareG, input.shareU);
  shareG.fill(0);
  try {
    return describeDataset(await decryptWithKey(key, input.ciphertext));
  } finally {
    key.fill(0);
  }
}

/** ipfs://<cid>/path -> gateway URL; https URLs pass through. */
export function contentHttpUrl(uri: string, ipfsGateway: string): string {
  if (uri.startsWith("ipfs://")) {
    return `${ipfsGateway.replace(/\/$/, "")}/ipfs/${uri.slice("ipfs://".length)}`;
  }
  return uri;
}

export async function fetchEncryptedContent(
  uri: string,
  ipfsGateway: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Uint8Array> {
  const response = await fetchImpl(contentHttpUrl(uri, ipfsGateway));
  if (!response.ok) {
    throw new Error(`content fetch failed (${response.status})`);
  }
  return new Uint8Array(await response.arrayBuffer());
}
