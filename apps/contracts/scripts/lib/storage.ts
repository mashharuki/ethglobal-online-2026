import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { OUT_DIR } from "./deployment.js";

/**
 * Content storage for seed artifacts. With PINATA_JWT set, files are pinned to IPFS via
 * Pinata and referenced as ipfs://<cid>. Otherwise they are written under out/storage/ and
 * referenced as file:// URIs (local dry run - NOT reachable by a deployed gateway).
 */
export type StoredObject = {
  uri: string;
  cid: string | null;
  localPath: string;
};

type PinResponse = { IpfsHash: string };

export async function storeObject(
  name: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<StoredObject> {
  const dir = resolve(OUT_DIR, "storage");
  mkdirSync(dir, { recursive: true });
  const localPath = resolve(dir, name);
  writeFileSync(localPath, bytes);

  const jwt = process.env.PINATA_JWT;
  if (jwt === undefined || jwt === "") {
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
      headers: { Authorization: `Bearer ${jwt}` },
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
