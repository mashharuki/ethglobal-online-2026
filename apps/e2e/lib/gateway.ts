import { PrivateKey } from "@hiero-ledger/sdk";
import {
  buildDomain,
  keyGateTypedData,
  recoverContentKey,
  unblindShareU,
} from "@truenft/shared";
import { createClientHederaSigner } from "@x402/hedera";
import { type Hex, hexToBytes, keccak256 } from "viem";
import { type PrivateKeyAccount, privateKeyToAccount } from "viem/accounts";
import { THRESHOLDS } from "../metrics";
import type { TestAccount } from "../wallets";

/**
 * Node-side driver for the deployed Access Gateway (tasks.md T116 / T118 / T058): the same
 * HTTP contract the web app and the MCP tools use, signed with the seeded Hedera Testnet
 * accounts. Nothing here is mocked: every call hits the live gateway, which re-reads Hedera.
 */
export class GatewayError extends Error {
  override readonly name = "GatewayError";
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export type Env = {
  gatewayUrl: string;
  mirrorUrl: string;
  chainId: number;
  rightsRegistry: Hex;
};

export function envFromProcess(): Env {
  const gatewayUrl = process.env.GATEWAY_URL ?? "";
  if (gatewayUrl === "") throw new Error("GATEWAY_URL is not set");
  const registry = process.env.RIGHTS_REGISTRY_ADDRESS ?? "";
  if (!/^0x[0-9a-fA-F]{40}$/.test(registry)) {
    throw new Error("RIGHTS_REGISTRY_ADDRESS is not set (EIP-712 domain)");
  }
  return {
    gatewayUrl: gatewayUrl.replace(/\/$/, ""),
    mirrorUrl:
      process.env.HEDERA_MIRROR_URL ?? "https://testnet.mirrornode.hedera.com",
    chainId: Number(process.env.HEDERA_CHAIN_ID ?? "296"),
    rightsRegistry: registry as Hex,
  };
}

async function parse(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

function fail(status: number, body: unknown): GatewayError {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<
    string,
    unknown
  >;
  const code =
    typeof b.code === "string"
      ? b.code
      : typeof b.error === "string"
        ? b.error
        : `HTTP_${status}`;
  return new GatewayError(
    status,
    code,
    typeof b.message === "string" ? b.message : `gateway answered ${status}`,
  );
}

async function getJson<T>(env: Env, path: string): Promise<T> {
  const response = await fetch(`${env.gatewayUrl}${path}`);
  const body = await parse(response);
  if (!response.ok) throw fail(response.status, body);
  return body as T;
}

async function postJson<T>(
  env: Env,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  const response = await fetch(`${env.gatewayUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const parsed = await parse(response);
  if (!response.ok) throw fail(response.status, parsed);
  return parsed as T;
}

export type AssetSummary = {
  assetId: Hex;
  tokenId: string;
  owner?: Hex;
  encryptedContentURI?: string;
  paidAccess: { price: string; durationSec: number; maxUses: number };
  transferMode: "SURVIVE_TRANSFER" | "INVALIDATE_ON_TRANSFER";
};

export function listAssets(env: Env): Promise<AssetSummary[]> {
  return getJson<AssetSummary[]>(env, "/assets");
}

/** The published asset `owner` currently holds (optionally of one transfer mode); throws when none. */
export async function findAssetOwnedBy(
  env: Env,
  owner: Hex,
  mode?: AssetSummary["transferMode"],
): Promise<AssetSummary> {
  const asset = (await listAssets(env)).find(
    (a) =>
      a.owner?.toLowerCase() === owner.toLowerCase() &&
      (mode === undefined || a.transferMode === mode),
  );
  if (asset === undefined) {
    throw new Error(
      `${owner} owns no ${mode ?? ""} asset: run the seed script first`,
    );
  }
  return asset;
}

function signerOf(account: TestAccount): PrivateKeyAccount {
  return privateKeyToAccount(account.privateKey);
}

type TypedData = Parameters<PrivateKeyAccount["signTypedData"]>[0];

export type OwnerRelease = {
  shareG: Hex;
  blindedU: Hex;
  accessEpochAtGrant: number;
  ownerSession: { token: string; expiresAt: number };
  encryptedContentURI: string;
  contentHash: Hex;
};

/** Owner path over HTTP: challenge -> OwnerAuthChallenge signature -> /owner/keygate. */
export async function ownerUnlock(
  env: Env,
  account: TestAccount,
  assetId: Hex,
  options: { domainChainId?: number } = {},
): Promise<{ release: OwnerRelease; keyGateSig: Hex }> {
  const signer = signerOf(account);
  const challenge = await postJson<{ typedData: TypedData }>(
    env,
    "/owner/challenge",
    { assetId, wallet: account.address, purpose: "owner-access" },
  );
  const typedData =
    options.domainChainId === undefined
      ? challenge.typedData
      : ({
          ...challenge.typedData,
          domain: {
            ...challenge.typedData.domain,
            chainId: options.domainChainId,
          },
        } as TypedData);
  const authSig = await signer.signTypedData(typedData);
  const keyGateSig = await signer.signTypedData(
    keyGateTypedData(buildDomain(env.rightsRegistry, env.chainId), {
      assetId,
      purpose: "owner",
      receiptHash: `0x${"00".repeat(32)}`,
    }) as TypedData,
  );
  const release = await postJson<OwnerRelease>(env, "/owner/keygate", {
    assetId,
    wallet: account.address,
    authSig,
    keyGateSig,
  });
  return { release, keyGateSig };
}

export type LicenseeRelease = {
  path: "licensee";
  shareG: Hex;
  blindedU: Hex;
  useIndex: number;
  onchainTx: string;
  encryptedContentURI: string;
  contentHash: Hex;
};

/** One licensee challenge + signature: what a single /keygate/share call needs. */
async function licenseeAuth(
  env: Env,
  account: TestAccount,
  receiptHash: Hex,
): Promise<Hex> {
  const challenge = await postJson<{ typedData: TypedData }>(
    env,
    "/keygate/challenge",
    { receiptHash, wallet: account.address },
  );
  return signerOf(account).signTypedData(challenge.typedData);
}

async function shareLicensee(
  env: Env,
  account: TestAccount,
  assetId: Hex,
  receiptHash: Hex,
  authSig?: Hex,
): Promise<{ release: LicenseeRelease; keyGateSig: Hex }> {
  const signer = signerOf(account);
  const keyGateSig = await signer.signTypedData(
    keyGateTypedData(buildDomain(env.rightsRegistry, env.chainId), {
      assetId,
      purpose: "licensee",
      receiptHash,
    }) as TypedData,
  );
  const release = await postJson<LicenseeRelease>(env, "/keygate/share", {
    path: "licensee",
    assetId,
    receiptHash,
    authSig: authSig ?? (await licenseeAuth(env, account, receiptHash)),
    keyGateSig,
  });
  return { release, keyGateSig };
}

/** One licensee consume: the share only (the rejection facets live here, not in decryption). */
export async function licenseeShare(
  env: Env,
  account: TestAccount,
  assetId: Hex,
  receiptHash: Hex,
  authSig?: Hex,
): Promise<LicenseeRelease> {
  return (await shareLicensee(env, account, assetId, receiptHash, authSig))
    .release;
}

/** Decrypted bytes plus the UTF-8 view when the payload is text (the demo datasets are CSV). */
export type Dataset = { bytes: Uint8Array; text?: string };

function contentUrl(uri: string): string {
  const gateway = (process.env.IPFS_GATEWAY_URL ?? "https://ipfs.io").replace(
    /\/$/,
    "",
  );
  return uri.startsWith("ipfs://")
    ? `${gateway}/ipfs/${uri.slice("ipfs://".length)}`
    : uri;
}

function toDataset(bytes: Uint8Array): Dataset {
  try {
    return {
      bytes,
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    };
  } catch {
    return { bytes };
  }
}

/**
 * The client half of the KeyGate, in Node: fetch the ciphertext, check it against the
 * manifest contentHash, unblind share_U with the KeyGateChallenge signature, K = share_G XOR
 * share_U, AES-256-GCM (iv || ciphertext || tag). Same steps as apps/web/src/keygate.
 */
async function decryptRelease(input: {
  assetId: Hex;
  keyGateSig: Hex;
  shareG: Hex;
  blindedU: Hex;
  encryptedContentURI: string;
  contentHash: Hex;
}): Promise<Dataset> {
  const response = await fetch(contentUrl(input.encryptedContentURI));
  if (!response.ok)
    throw new Error(`content fetch failed (${response.status})`);
  const blob = new Uint8Array(await response.arrayBuffer());
  if (keccak256(blob).toLowerCase() !== input.contentHash.toLowerCase()) {
    throw new Error(
      "CONTENT_HASH_MISMATCH: ciphertext does not match the manifest contentHash",
    );
  }
  const shareU = await unblindShareU(
    hexToBytes(input.blindedU),
    input.keyGateSig,
    input.assetId,
  );
  const key = recoverContentKey(hexToBytes(input.shareG), shareU).slice();
  try {
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      key,
      { name: "AES-GCM" },
      false,
      ["decrypt"],
    );
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: blob.slice(0, 12) },
      cryptoKey,
      blob.slice(12),
    );
    const dataset = toDataset(new Uint8Array(plain));
    if (dataset.bytes.length === 0)
      throw new Error("decrypted dataset is empty");
    return dataset;
  } finally {
    key.fill(0);
    shareU.fill(0);
  }
}

/** Licensee path to the plaintext: share (consume) + decrypt. */
export async function licenseeDecrypt(
  env: Env,
  account: TestAccount,
  assetId: Hex,
  receiptHash: Hex,
): Promise<{ useIndex: number; dataset: Dataset }> {
  const { release, keyGateSig } = await shareLicensee(
    env,
    account,
    assetId,
    receiptHash,
  );
  const dataset = await decryptRelease({
    assetId,
    keyGateSig,
    shareG: release.shareG,
    blindedU: release.blindedU,
    encryptedContentURI: release.encryptedContentURI,
    contentHash: release.contentHash,
  });
  return { useIndex: release.useIndex, dataset };
}

type ReplayOutcome =
  | { ok: true; useIndex: number; ms: number }
  | { ok: false; code: string; ms: number };

export type ReplayResult = {
  outcomes: ReplayOutcome[];
  /** whole burst, including the one call that waits for Hedera finality */
  elapsedMs: number;
  /** the slowest app-layer rejection (NaN when nothing was rejected) */
  rejectMs: number;
};

/** The codes a duplicate share of one receipt may legitimately be refused with (§10.1 row 1). */
const REPLAY_REJECT_CODES = [
  "RECEIPT_ALREADY_CONSUMED",
  "SETTLEMENT_IN_PROGRESS",
];

/**
 * SC-005: `parallelism` /keygate/share calls with the SAME receipt, all in flight together
 * (Promise.all over pre-signed challenges). Each outcome carries its own completion time so
 * the rejection latency is measured per rejection, not as the tail of the settled call.
 */
export async function concurrentReplay(
  env: Env,
  account: TestAccount,
  assetId: Hex,
  receiptHash: Hex,
  parallelism: number,
): Promise<ReplayResult> {
  const sigs: Hex[] = [];
  for (let i = 0; i < parallelism; i += 1) {
    sigs.push(await licenseeAuth(env, account, receiptHash));
  }
  const started = performance.now();
  const outcomes = await Promise.all(
    sigs.map(async (authSig): Promise<ReplayOutcome> => {
      try {
        const released = await licenseeShare(
          env,
          account,
          assetId,
          receiptHash,
          authSig,
        );
        return {
          ok: true,
          useIndex: released.useIndex,
          ms: performance.now() - started,
        };
      } catch (error) {
        return {
          ok: false,
          code: error instanceof GatewayError ? error.code : "NETWORK",
          ms: performance.now() - started,
        };
      }
    }),
  );
  const rejections = outcomes.filter((o) => !o.ok).map((o) => o.ms);
  return {
    outcomes,
    elapsedMs: performance.now() - started,
    rejectMs: rejections.length === 0 ? Number.NaN : Math.max(...rejections),
  };
}

/**
 * The SC-005 verdict: exactly one settled use, every other call refused with a replay code
 * (never a network error / 5xx), and the slowest refusal inside the quickstart budget.
 */
export function assertReplay(result: ReplayResult, parallelism: number): void {
  const settled = result.outcomes.filter((o) => o.ok);
  const rejected = result.outcomes.filter((o) => !o.ok);
  const problems: string[] = [];
  if (settled.length !== 1) problems.push(`${settled.length} settled (want 1)`);
  if (rejected.length !== parallelism - 1) {
    problems.push(`${rejected.length} rejected (want ${parallelism - 1})`);
  }
  for (const r of rejected) {
    if (!r.ok && !REPLAY_REJECT_CODES.includes(r.code))
      problems.push(`unexpected ${r.code}`);
  }
  const budget = THRESHOLDS.replay_reject_ms?.max ?? Number.NaN;
  if (!(result.rejectMs < budget)) {
    problems.push(
      `slowest rejection ${Math.round(result.rejectMs)}ms (budget ${budget}ms)`,
    );
  }
  if (problems.length > 0)
    throw new Error(`concurrent replay: ${problems.join("; ")}`);
}

/** Hedera account id (0.0.x) behind an EVM address, via the mirror node. */
async function hederaAccountOf(env: Env, evmAddress: Hex): Promise<string> {
  const response = await fetch(
    `${env.mirrorUrl}/api/v1/accounts/${evmAddress.toLowerCase()}`,
  );
  if (!response.ok) {
    throw new Error(
      `no Hedera account for ${evmAddress} (mirror ${response.status})`,
    );
  }
  const body = (await response.json()) as { account?: string };
  if (typeof body.account !== "string")
    throw new Error("mirror node: no account id");
  return body.account;
}

type PaymentAccept = {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  maxAmountRequired: string;
  payTo: string;
  maxTimeoutSeconds?: number;
  extra: Record<string, unknown>;
};

export type Settled = {
  receiptHash: Hex;
  receipt: Record<string, unknown>;
  serverSignature: Hex;
  onchainTx: string;
  maxUses: number;
  expiresAt: number;
  settlementMode: string;
};

/**
 * x402 purchase from Node (tasks.md T058 / T116): 402 quote -> a real HBAR transfer signed
 * with the seeded key (@x402/hedera client signer) -> X-PAYMENT -> Rights Receipt.
 */
export async function buyWithHbar(
  env: Env,
  account: TestAccount,
  assetId: Hex,
): Promise<{ accept: PaymentAccept; settled: Settled }> {
  const response = await fetch(`${env.gatewayUrl}/assets/${assetId}/paid`);
  const required = (await parse(response)) as { accepts?: PaymentAccept[] };
  if (response.status !== 402 || required.accepts?.[0] === undefined) {
    throw fail(response.status, required);
  }
  const accept = required.accepts[0];
  const accountId = await hederaAccountOf(env, account.address);
  const signer = createClientHederaSigner(
    accountId,
    PrivateKey.fromStringECDSA(account.privateKey.slice(2)),
  );
  const transaction = await signer.createPartiallySignedTransferTransaction({
    scheme: "exact",
    network: accept.network as "hedera:testnet",
    asset: accept.asset,
    amount: accept.amount,
    payTo: accept.payTo,
    maxTimeoutSeconds: accept.maxTimeoutSeconds ?? 600,
    extra: accept.extra,
  });
  const xPayment = Buffer.from(
    JSON.stringify({
      x402Version: 2,
      scheme: "exact",
      network: accept.network,
      payload: { transaction },
      accepted: accept,
    }),
  ).toString("base64");
  const settled = await postJson<Settled>(
    env,
    `/assets/${assetId}/paid`,
    { licensee: account.address },
    { "X-PAYMENT": xPayment },
  );
  return { accept, settled };
}
