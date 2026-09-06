import { buildDomain, keyGateTypedData } from "@truenft/shared";
import type { Address, Hex } from "viem";
import {
  type Api,
  type KeygateShareLicenseeResponse,
  keygateShare,
  licenseeChallenge,
  type OwnerKeygateResponse,
  ownerChallenge,
  ownerKeygate,
} from "../api/client";
import type { Signers, TypedDataLike } from "../chain/hooks";
import {
  type Dataset,
  decryptContent,
  fetchEncryptedContent,
} from "../keygate/decrypt";
import { deriveShareU } from "../keygate/deriveShareU";

/**
 * The two client-side access flows (tasks.md T112, gateway-api.md 所有者パス / 購入者パス):
 * challenge -> EIP-712 auth signature (never reused) -> KeyGateChallenge signature (key
 * material, stable per wallet + asset) -> share_G + blindedU -> K in the browser -> plaintext.
 */
const ZERO32 = `0x${"00".repeat(32)}` as Hex;

export type AccessDeps = {
  api: Api;
  signers: Signers;
  wallet: Address;
  deployment: { rightsRegistry: Address; chainId: number };
  ipfsGateway: string;
  fetchImpl?: typeof fetch;
};

function typedData(value: unknown): TypedDataLike {
  return value as TypedDataLike;
}

async function keyGateSignature(
  deps: AccessDeps,
  assetId: Hex,
  purpose: "owner" | "licensee",
  receiptHash: Hex,
): Promise<Hex> {
  const domain = buildDomain(
    deps.deployment.rightsRegistry,
    deps.deployment.chainId,
  );
  return deps.signers.signTypedData(
    typedData(keyGateTypedData(domain, { assetId, purpose, receiptHash })),
  );
}

async function unlock(
  deps: AccessDeps,
  assetId: Hex,
  keyGateSig: Hex,
  release: {
    shareG: string;
    blindedU: string;
    encryptedContentURI: string;
    contentHash: string;
  },
): Promise<Dataset> {
  const shareU = await deriveShareU({
    blindedU: release.blindedU as Hex,
    keyGateSig,
    assetId,
  });
  try {
    const ciphertext = await fetchEncryptedContent(
      release.encryptedContentURI,
      deps.ipfsGateway,
      deps.fetchImpl,
    );
    return await decryptContent({
      shareG: release.shareG as Hex,
      shareU,
      ciphertext,
      contentHash: release.contentHash as Hex,
    });
  } finally {
    shareU.fill(0);
  }
}

export async function accessAsOwner(
  deps: AccessDeps,
  assetId: Hex,
): Promise<{ release: OwnerKeygateResponse; dataset: Dataset }> {
  const challenge = await ownerChallenge(deps.api, {
    assetId,
    wallet: deps.wallet,
    purpose: "owner-access",
  });
  const authSig = await deps.signers.signTypedData(
    typedData(challenge.typedData),
  );
  const keyGateSig = await keyGateSignature(deps, assetId, "owner", ZERO32);
  const release = await ownerKeygate(deps.api, {
    assetId,
    wallet: deps.wallet,
    authSig,
    keyGateSig,
  });
  return { release, dataset: await unlock(deps, assetId, keyGateSig, release) };
}

export async function accessAsLicensee(
  deps: AccessDeps,
  assetId: Hex,
  receiptHash: Hex,
): Promise<{ release: KeygateShareLicenseeResponse; dataset: Dataset }> {
  const challenge = await licenseeChallenge(deps.api, {
    receiptHash,
    wallet: deps.wallet,
  });
  const authSig = await deps.signers.signTypedData(
    typedData(challenge.typedData),
  );
  const keyGateSig = await keyGateSignature(
    deps,
    assetId,
    "licensee",
    receiptHash,
  );
  const released = await keygateShare(deps.api, {
    path: "licensee",
    assetId,
    receiptHash,
    authSig,
    keyGateSig,
  });
  if (released.path !== "licensee") {
    throw new Error("gateway answered the owner shape on the licensee path");
  }
  return {
    release: released,
    dataset: await unlock(deps, assetId, keyGateSig, released),
  };
}
