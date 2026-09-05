import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Content storage for seed artifacts. With PINATA_JWT set, files are pinned to IPFS via
 * Pinata and referenced as ipfs://<cid>. Otherwise they are written under <outDir>/storage/
 * and referenced as file:// URIs (local dry run - NOT reachable by a deployed gateway; seed.ts
 * refuses this mode on Hedera testnet unless --allow-local-storage is passed).
 */
export type StoredObject = {
  uri: string;
  cid: string | null;
  localPath: string;
};

type PinResponse = { IpfsHash: string };

export function hasPinata(): boolean {
  const jwt = process.env.PINATA_JWT;
  return jwt !== undefined && jwt !== "";
}

export async function storeObject(
  outDir: string,
  name: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<StoredObject> {
  const dir = resolve(outDir, "storage");
  mkdirSync(dir, { recursive: true });
  const localPath = resolve(dir, name);
  writeFileSync(localPath, bytes);

  if (!hasPinata()) {
    return { uri: `file://${localPath}`, cid: null, localPath };
  }
  const form = new FormData();
  form.append(
    "file",
    new Blob([Uint8Array.from(bytes)], { type: contentType }),
    name,
  );
  form.append("pinataMetadata", JSON.stringify({ name }));
  const response = await fetch(
    "https://api.pinata.cloud/pinning/pinFileToIPFS",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.PINATA_JWT}` },
      body: form,
    },
  );
  if (!response.ok) {
    throw new Error(
      `pinata pin failed (${response.status}): ${await response.text()}`,
    );
  }
  const body = (await response.json()) as PinResponse;
  return { uri: `ipfs://${body.IpfsHash}`, cid: body.IpfsHash, localPath };
}
