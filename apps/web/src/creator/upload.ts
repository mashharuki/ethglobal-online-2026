import type { components } from "@truenft/openapi";
import { PinataSDK } from "pinata";
import { type Api, toGatewayError } from "../api/client";

type Purpose = components["schemas"]["CreatorUploadRequest"]["purpose"];
const limits = {
  preview: {
    size: 10 * 1024 * 1024,
    types: ["image/png", "image/jpeg", "image/webp", "application/json"],
  },
  "encrypted-content": {
    size: 25 * 1024 * 1024,
    types: ["application/octet-stream"],
  },
  manifest: { size: 256 * 1024, types: ["application/json"] },
} as const;

export async function uploadCreatorFile(
  api: Api,
  getAccessToken: () => Promise<string | null>,
  purpose: Purpose,
  file: File,
): Promise<string> {
  const limit = limits[purpose];
  const mimeType = limit.types.find((type) => type === file.type);
  if (file.size === 0 || file.size > limit.size || mimeType === undefined) {
    throw new Error(
      `Invalid ${purpose} file: allowed types ${limit.types.join(", ")}, maximum ${limit.size} bytes`,
    );
  }
  const token = await getAccessToken();
  if (!token) throw new Error("Sign in before uploading to IPFS");
  const result = await api.POST("/creator/uploads", {
    headers: { Authorization: `Bearer ${token}` },
    body: { purpose, size: file.size, mimeType },
  });
  if (!result.data) throw toGatewayError(result.response.status, result.error);
  try {
    const url = new URL(result.data.signedUrl);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "uploads.pinata.cloud" ||
      url.username ||
      url.password ||
      url.port
    )
      throw new Error("Invalid upload URL");
    const uploaded = await new PinataSDK({}).upload.public
      .file(file)
      .url(url.href);
    // CIDv0 (base58btc sha2-256) or CIDv1 base32; no paths, queries, or arbitrary URLs.
    if (!/^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,120})$/.test(uploaded.cid))
      throw new Error("Invalid CID");
    return `ipfs://${uploaded.cid}`;
  } catch {
    // SDK errors may include the bearer signed URL. Never surface them to UI or logs.
    throw new Error("IPFS upload failed; retry to obtain a fresh upload URL");
  }
}
