import { PrivateKey } from "@hiero-ledger/sdk";
import { buildDomain, keyGateTypedData } from "@truenft/shared";
import { createClientHederaSigner } from "@x402/hedera";
import type { Hex } from "viem";
import { type PrivateKeyAccount, privateKeyToAccount } from "viem/accounts";
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

export async function licenseeShare(
  env: Env,
  account: TestAccount,
  assetId: Hex,
  receiptHash: Hex,
  authSig?: Hex,
): Promise<LicenseeRelease> {
  const signer = signerOf(account);
  const keyGateSig = await signer.signTypedData(
    keyGateTypedData(buildDomain(env.rightsRegistry, env.chainId), {
      assetId,
      purpose: "licensee",
      receiptHash,
    }) as TypedData,
  );
  return postJson<LicenseeRelease>(env, "/keygate/share", {
    path: "licensee",
    assetId,
    receiptHash,
    authSig: authSig ?? (await licenseeAuth(env, account, receiptHash)),
    keyGateSig,
  });
}

export type ReplayOutcome =
  | { ok: true; useIndex: number }
  | { ok: false; code: string };

/**
 * SC-005: `parallelism` /keygate/share calls with the SAME receipt, all in flight together
 * (Promise.all over pre-signed challenges). Returns the outcomes and the wall time of the
 * whole burst - the app-layer rejections must land inside that window.
 */
export async function concurrentReplay(
  env: Env,
  account: TestAccount,
  assetId: Hex,
  receiptHash: Hex,
  parallelism: number,
): Promise<{ outcomes: ReplayOutcome[]; elapsedMs: number }> {
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
        return { ok: true, useIndex: released.useIndex };
      } catch (error) {
        return {
          ok: false,
          code: error instanceof GatewayError ? error.code : "NETWORK",
        };
      }
    }),
  );
  return { outcomes, elapsedMs: performance.now() - started };
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
