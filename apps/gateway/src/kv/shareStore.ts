import { decryptShareG, shareGKvKey } from "@truenft/shared";
import type { Hex } from "viem";
import type { Env } from "../env";
import { readKek, wipe } from "../keygate/vault";

/**
 * Workers KV `SHARE_G` access (tasks.md T076). Blobs are written by
 * scripts/load-shares.ts using packages/shared kv-format (the only writer) and decrypted
 * here with KV_KEK at release time only. The plaintext share is returned to the caller,
 * who must `wipe()` it after use; the KEK bytes are wiped before returning.
 */
export class ShareNotLoadedError extends Error {
  override readonly name = "ShareNotLoadedError";
  constructor(readonly assetId: Hex) {
    super(`share_G is not loaded for asset ${assetId} (run load-shares)`);
  }
}

export async function hasShareG(env: Env, assetId: Hex): Promise<boolean> {
  return (await env.SHARE_G.get(shareGKvKey(assetId), "text")) !== null;
}

/** Stores an ALREADY ENCRYPTED blob (tc-kv-v1). Plaintext never goes through this function. */
export async function putEncryptedShareG(
  env: Env,
  assetId: Hex,
  encryptedBlob: string,
): Promise<void> {
  if (!encryptedBlob.startsWith("tc-kv-v1:")) {
    throw new Error(
      "refusing to store a share_G blob that is not tc-kv-v1 ciphertext",
    );
  }
  await env.SHARE_G.put(shareGKvKey(assetId), encryptedBlob);
}

export async function loadShareG(env: Env, assetId: Hex): Promise<Uint8Array> {
  const blob = await env.SHARE_G.get(shareGKvKey(assetId), "text");
  if (blob === null) throw new ShareNotLoadedError(assetId);
  const kek = readKek(env);
  try {
    return await decryptShareG(blob, kek, assetId);
  } finally {
    wipe(kek);
  }
}
