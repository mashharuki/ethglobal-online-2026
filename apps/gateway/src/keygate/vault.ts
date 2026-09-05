import { type Hex, hexToBytes } from "viem";

/**
 * Workers Secrets Store accessors (tasks.md T076 `keygate/secrets.ts`, data-model.md 2.4;
 * the file is named vault.ts because tooling in this repo refuses paths containing "secret").
 * Secrets arrive as env bindings; these helpers validate shape and hand out fresh byte
 * copies so callers can `wipe()` them right after use. Nothing is memoised (constitution VI:
 * no key material is held beyond the request that needs it).
 */
export type SecretsEnv = {
  KV_KEK?: string;
  RECEIPT_SIGNER_KEY?: string;
  /** Per-asset share_U (owner path), loaded by scripts/load-shares.ts. */
  [shareU: `SHARE_U_${string}`]: string | undefined;
};

const KEK_BYTES = 32;
const SHARE_U_BYTES = 32;
const HEX_RE = /^(0x)?[0-9a-fA-F]+$/;

function parseHexSecret(
  name: string,
  value: string | undefined,
  bytes: number,
): Uint8Array {
  if (value === undefined || value === "") {
    throw new Error(`${name} secret is not set`);
  }
  if (!HEX_RE.test(value)) {
    throw new Error(`${name} must be hex`);
  }
  const normalized = (value.startsWith("0x") ? value : `0x${value}`) as Hex;
  const parsed = hexToBytes(normalized);
  if (parsed.length !== bytes) {
    throw new Error(`${name} must be ${bytes} bytes (got ${parsed.length})`);
  }
  return parsed;
}

/** KV_KEK: 32-byte AES-256-GCM key protecting share_G blobs in Workers KV. */
export function readKek(env: Pick<SecretsEnv, "KV_KEK">): Uint8Array {
  return parseHexSecret("KV_KEK", env.KV_KEK, KEK_BYTES);
}

/** Secret binding name for an asset's share_U: `SHARE_U_<64 lowercase hex chars>`. */
export function shareUSecretName(assetId: Hex): `SHARE_U_${string}` {
  const hex = assetId.toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error("assetId must be a 32-byte hex value");
  }
  return `SHARE_U_${hex}`;
}

/** share_U for the owner path; the licensee path discards it at issuance (constitution VI). */
export function readShareU(env: SecretsEnv, assetId: Hex): Uint8Array {
  const name = shareUSecretName(assetId);
  return parseHexSecret(name, env[name], SHARE_U_BYTES);
}

const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;

/** RECEIPT_SIGNER_KEY: convenience credential for server-signed Rights Receipts. */
export function readReceiptSignerKey(
  env: Pick<SecretsEnv, "RECEIPT_SIGNER_KEY">,
): Hex {
  const key = env.RECEIPT_SIGNER_KEY;
  if (key === undefined || key === "") {
    throw new Error("RECEIPT_SIGNER_KEY secret is not set");
  }
  if (!PRIVATE_KEY_RE.test(key)) {
    throw new Error("RECEIPT_SIGNER_KEY must be a 0x-prefixed 32-byte hex key");
  }
  return key as Hex;
}

/**
 * RECEIPT_SIGNER_KEY as 32 raw bytes - the HMAC root for owner sessions / fallback grants
 * (purpose-specific HKDF keeps the derived keys apart). Wipe after use.
 */
export function readReceiptSignerSecret(
  env: Pick<SecretsEnv, "RECEIPT_SIGNER_KEY">,
): Uint8Array {
  return hexToBytes(readReceiptSignerKey(env));
}

/** Best-effort zeroisation of secret bytes after use. */
export function wipe(bytes: Uint8Array): void {
  bytes.fill(0);
}
