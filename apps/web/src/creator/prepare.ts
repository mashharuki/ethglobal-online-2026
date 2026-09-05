import {
  computeConditionsHash,
  computeResourceHash,
  manifestPolicyHash,
  parseManifest,
  type RightsManifest,
  SHARE_BYTES,
  xorBytes,
} from "@truenft/shared";
import { type Address, bytesToHex, type Hex, keccak256 } from "viem";

/**
 * Creator console (tasks.md T110), the part that runs before the mint: encrypt the dataset
 * client side with a fresh AES-256-GCM key K, split K into share_G / share_U (XOR 2-of-2), and
 * build a Rights Manifest that passes packages/shared validation. The encrypted blob and the
 * manifest go to IPFS (the creator uploads them and pastes the URIs); the shares go to the
 * gateway operator (scripts/load-shares.ts). Nothing here leaves the browser.
 */
const OWNER_CONDITION = "ownerOf(tokenId) == caller";
const LICENSE_CONDITION = "hasValidConsumption(receiptHash, useIndex)";

export async function encryptDataset(
  plaintext: Uint8Array,
): Promise<{ key: Uint8Array; blob: Uint8Array }> {
  const key = crypto.getRandomValues(new Uint8Array(SHARE_BYTES));
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key.slice(),
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      cryptoKey,
      plaintext.slice(),
    ),
  );
  const blob = new Uint8Array(12 + ciphertext.length);
  blob.set(iv, 0);
  blob.set(ciphertext, 12);
  return { key, blob };
}

export function splitKey(key: Uint8Array): {
  shareG: Uint8Array;
  shareU: Uint8Array;
} {
  const shareG = crypto.getRandomValues(new Uint8Array(SHARE_BYTES));
  return { shareG, shareU: xorBytes(key, shareG) };
}

export type ManifestDraft = {
  chainId: number;
  nftContract: Address;
  rightsRegistry: Address;
  name: string;
  previewURI: string;
  encryptedContentURI: string;
  contentHash: Hex;
  priceHbar: string;
  durationSec: number;
  maxUses: number;
  transferMode: "SURVIVE_TRANSFER" | "INVALIDATE_ON_TRANSFER";
  permissions: {
    commercialUse: boolean;
    aiTraining: boolean;
    derivativeGeneration: boolean;
  };
  creatorBps: number;
};

const WEIBAR_PER_HBAR = 10n ** 18n;

/** "1.5" HBAR -> weibar string (tinybar precision, as the manifest schema requires). */
export function hbarToWeibar(hbar: string): string {
  const [whole, frac = ""] = hbar.trim().split(".");
  if (!/^\d+$/.test(whole ?? "") || !/^\d{0,8}$/.test(frac)) {
    throw new Error(
      "price must be a decimal HBAR amount with at most 8 decimals",
    );
  }
  const tinybar =
    BigInt(whole ?? "0") * 100_000_000n + BigInt(frac.padEnd(8, "0"));
  return (tinybar * (WEIBAR_PER_HBAR / 100_000_000n)).toString();
}

/** Deterministic assetId for a new work: keccak256(chainId, creator-chosen name, contentHash). */
function deriveAssetId(chainId: number, name: string, contentHash: Hex): Hex {
  return keccak256(
    new TextEncoder().encode(
      `truecollective/${chainId}/${name}/${contentHash}`,
    ),
  );
}

/** tokenId is only known after the mint: the manifest is built twice (draft, then final). */
export function buildManifest(
  draft: ManifestDraft,
  tokenId: string,
): {
  manifest: RightsManifest;
  assetId: Hex;
  policyHash: Hex;
  resourceHash: Hex;
} {
  const assetId = deriveAssetId(draft.chainId, draft.name, draft.contentHash);
  const candidate = {
    schemaVersion: "1.0",
    assetId,
    nftContract: draft.nftContract,
    tokenId,
    previewURI: draft.previewURI,
    encryptedContentURI: draft.encryptedContentURI,
    contentHash: draft.contentHash,
    keyGate: {
      scheme: "xor-2share",
      keyGateVersion: 1,
      conditionsHash: computeConditionsHash({
        ownerCondition: OWNER_CONDITION,
        licenseCondition: LICENSE_CONDITION,
        verifyingContract: draft.rightsRegistry,
      }),
      ownerCondition: OWNER_CONDITION,
      licenseCondition: LICENSE_CONDITION,
    },
    ownerAccess: { price: "0", durationSec: 3600 },
    paidAccess: {
      price: hbarToWeibar(draft.priceHbar),
      durationSec: draft.durationSec,
      maxUses: draft.maxUses,
    },
    permissions: draft.permissions,
    transferMode: draft.transferMode,
    revenueSplit: {
      creatorBps: draft.creatorBps,
      ownerBps: 10_000 - draft.creatorBps,
    },
  };
  const parsed = parseManifest(candidate);
  if (!parsed.ok) {
    throw new Error(
      `manifest invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    );
  }
  const manifest = parsed.data;
  return {
    manifest,
    assetId,
    policyHash: manifestPolicyHash(manifest),
    resourceHash: computeResourceHash({
      nftContract: draft.nftContract,
      tokenId: BigInt(tokenId),
      assetId,
      contentHash: draft.contentHash,
    }),
  };
}

export function contentHashOf(blob: Uint8Array): Hex {
  return keccak256(blob);
}

export function sharesArtifact(input: {
  assetId: Hex;
  shareG: Uint8Array;
  shareU: Uint8Array;
}): string {
  return JSON.stringify(
    {
      assetId: input.assetId,
      shareG: bytesToHex(input.shareG),
      shareU: bytesToHex(input.shareU),
      note: "hand to the gateway operator: scripts/load-shares.ts puts shareG into KV and shareU into SHARE_U_<assetId>",
    },
    null,
    2,
  );
}
