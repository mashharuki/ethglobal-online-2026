import {
  buildDomain,
  computeReceiptHash,
  type RightsReceipt,
  TransferMode,
} from "@truenft/shared";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Db } from "../../src/db/types";
import type { ReceiptParamsJson } from "../../src/do/operatorQueueCore";
import type { Env } from "../../src/env";
import { AppError } from "../../src/errors";
import type { GraphFetch } from "../../src/graph/cache";
import type { ReleasePorts } from "../../src/keygate/release";
import { AssetNotFoundError } from "../../src/manifest/resolver";
import { type AgentWallet, createLocalAgentWallet } from "../../src/mcp/wallet";
import type { Services } from "../../src/services";
import type { PaymentPayload } from "../../src/x402/facilitator";
import type { ReceiptQuote, SettlePorts } from "../../src/x402/settle";
import {
  CHAIN_ID,
  RIGHTS_NFT,
  RIGHTS_REGISTRY,
  type TestAsset,
} from "./helpers";

/**
 * Injected chain / facilitator / operator / wallet fakes shared by the HTTP route tests and
 * the MCP tests. Everything the gateway would read from Hedera or Blocky402 is a knob on
 * `Fake`; the PGlite database and the KeyGate arithmetic are real.
 */
export const owner = privateKeyToAccount(`0x${"a1".repeat(32)}`);
export const creator = privateKeyToAccount(`0x${"c0".repeat(32)}`);
export const buyer = privateKeyToAccount(`0x${"b7".repeat(32)}`);
export const stranger = privateKeyToAccount(`0x${"b2".repeat(32)}`);
export const NOW = new Date("2026-09-06T12:00:00Z");
export const domain = buildDomain(RIGHTS_REGISTRY, CHAIN_ID);
export const ZERO32 = `0x${"00".repeat(32)}` as Hex;
export const PAYER_ACCOUNT = "0.0.4242";

export type Fake = {
  licenseEpoch: bigint;
  accessEpoch: bigint;
  /** when set, successive quoteReads calls consume these accessEpoch values (last one sticks) */
  accessEpochSequence?: bigint[];
  tokenOwner: Address;
  creator: Address;
  verifyOk: boolean;
  payerAccount: string;
  payerEvm: Address;
  operatorJobs: unknown[];
  bumps: unknown[];
  graphResult: unknown;
  graphThrows: boolean;
  consumeCalls: number;
  mode: "primary" | "fallback" | "custodial";
  settlementAccountId: string;
  settleCalls: number;
  /** operator rejects with the ReceiptAlreadyIssued mapping (retry after broadcast crash) */
  operatorConflict: boolean;
  /** receipt hashes RightsRegistry.receiptStatus(hash).issued answers true for */
  issuedOnChain: Set<Hex>;
  /** the "mined" tx emits a foreign receipt instead of ours */
  minesWrongHash: boolean;
  /** facilitator /settle: throws (outcome unknown), throws an AppError, or answers success=false */
  settleThrows: boolean;
  settleThrowsAppError: boolean;
  settleRejects: boolean;
  settleDelayMs: number;
  /** the receipt wait (tx confirmation) blows up */
  receiptWaitThrows: boolean;
  /** injected clock (lease expiry) */
  now: Date;
  /** facilitator /supported fee payer for hedera:testnet ("" = none advertised) */
  feePayer: string;
  /** encrypted content served for any URI (MCP decrypt_content) */
  contentBlob: Uint8Array;
  /** MCP agent wallet + its Hedera account (buyer's key by default) */
  agentWallet: AgentWallet;
  agentAccountId: string;
  /** MCP spend cap per session, tinybar */
  spendCap: bigint;
  /** how many times the agent wallet was asked to sign (typed data or raw hash) */
  signCalls: number;
  /** when set, the next facilitator /verify signals entry, then awaits `wait` before answering */
  verifyGate?: { entered: () => void; wait: Promise<void> };
};

export function paymentHeader(
  asset: TestAsset,
  quote: ReceiptQuote,
  salt = "tx-1",
): string {
  const payload: PaymentPayload = {
    x402Version: 2,
    scheme: "exact",
    network: "hedera:testnet",
    payload: { transaction: `base64:${salt}` },
    accepted: {
      scheme: "exact",
      network: "hedera:testnet",
      asset: "0.0.0",
      amount: (
        BigInt(asset.manifest.paidAccess.price) / 10_000_000_000n
      ).toString(),
      maxAmountRequired: asset.manifest.paidAccess.price,
      payTo: "0.0.9999",
      resource: `/assets/${asset.assetId}/paid`,
      extra: {
        settlementMode: "custodial",
        value: asset.manifest.paidAccess.price,
        receiptQuote: quote,
      },
    },
  };
  return btoa(JSON.stringify(payload));
}

export function receiptFromParams(p: ReceiptParamsJson): RightsReceipt {
  return {
    ...p,
    chainId: BigInt(CHAIN_ID),
    verifyingContract: RIGHTS_REGISTRY,
    tokenId: BigInt(p.tokenId),
    licenseEpoch: BigInt(p.licenseEpoch),
    ownerEpochAtIssue: BigInt(p.ownerEpochAtIssue),
    transferMode:
      p.transferMode === 1
        ? TransferMode.INVALIDATE_ON_TRANSFER
        : TransferMode.SURVIVE_TRANSFER,
    expiresAt: BigInt(p.expiresAt),
    issuedAt: BigInt(p.issuedAt),
  };
}

export type World = { db: Db; env: Env; asset: TestAsset; fake: Fake };

export function buildServices(w: World): Services {
  const { db, env, asset, fake } = w;
  const deployment = {
    chainId: CHAIN_ID,
    rightsNFT: RIGHTS_NFT,
    rightsRegistry: RIGHTS_REGISTRY,
  };
  const resolveAsset = async (assetId: Hex) => {
    if (assetId.toLowerCase() !== asset.assetId.toLowerCase())
      throw new AssetNotFoundError(assetId);
    return {
      assetId: asset.assetId,
      tokenId: asset.tokenId,
      nftContract: RIGHTS_NFT,
      manifest: asset.manifest,
    };
  };
  const release: ReleasePorts = {
    env,
    db,
    deployment,
    chain: {
      ownerSnapshot: async () => ({
        owner: fake.tokenOwner,
        accessEpoch: fake.accessEpoch,
        policyHash: asset.policyHash,
        resourceHash: asset.resourceHash,
      }),
      tokenHashes: async () => ({
        policyHash: asset.policyHash,
        resourceHash: asset.resourceHash,
      }),
      receiptStatus: async () => ({
        issued: true,
        tokenId: asset.tokenId,
        licensee: buyer.address,
        maxUses: 5,
        usedCount: 0,
        expiresAt: BigInt(Math.floor(NOW.getTime() / 1000) + 300),
      }),
      hasValidConsumption: async () => true,
      getCode: async () => "0x",
    },
    resolveAsset,
    consume: async () => {
      fake.consumeCalls += 1;
      return {
        useIndex: 0,
        onchainTx: `0x${"77".repeat(32)}`,
        redelivered: false,
      };
    },
    now: () => fake.now,
  };
  // the operator "mines" settleAndIssue: the tx hash encodes the params so receiptHashFromTx
  // can recompute exactly what the contract would have emitted
  const mined = new Map<string, Hex>();
  const settle: SettlePorts = {
    env,
    db,
    deployment,
    get mode() {
      return fake.mode;
    },
    get settlementAccountId() {
      return fake.settlementAccountId;
    },
    facilitator: {
      supported: async () => ({ kinds: [] }),
      feePayer: async () => (fake.feePayer === "" ? undefined : fake.feePayer),
      verify: async () => {
        // one-shot barrier so a test can park a request inside its claim
        const gate = fake.verifyGate;
        fake.verifyGate = undefined;
        if (gate !== undefined) {
          gate.entered();
          await gate.wait;
        }
        return {
          isValid: fake.verifyOk,
          invalidReason: fake.verifyOk ? undefined : "bad",
          payer: fake.payerAccount === "" ? undefined : fake.payerAccount,
        };
      },
      settle: async () => {
        fake.settleCalls += 1;
        if (fake.settleDelayMs > 0) {
          await new Promise((r) => setTimeout(r, fake.settleDelayMs));
        }
        if (fake.settleThrows) throw new Error("facilitator timeout");
        if (fake.settleThrowsAppError) {
          throw new AppError(
            "UNDERPAYMENT",
            "facilitator answered 402 mid-flight",
          );
        }
        return {
          success: !fake.settleRejects,
          errorReason: fake.settleRejects ? "insufficient" : undefined,
          transaction: "0.0.4242@1700000000.000000001",
          network: "hedera:testnet",
          payer: fake.payerAccount,
        };
      },
    },
    resolveAsset,
    quoteReads: async () => {
      const seq = fake.accessEpochSequence;
      if (seq !== undefined && seq.length > 0) {
        fake.accessEpoch =
          seq.length > 1
            ? (seq.shift() ?? fake.accessEpoch)
            : (seq[0] ?? fake.accessEpoch);
      }
      return {
        licenseEpoch: fake.licenseEpoch,
        accessEpoch: fake.accessEpoch,
        policyHash: asset.policyHash,
        resourceHash: asset.resourceHash,
      };
    },
    operator: async (job) => {
      if (fake.operatorConflict) {
        throw new AppError(
          "PAYMENT_ID_PAYLOAD_CONFLICT",
          "ReceiptAlreadyIssued",
        );
      }
      fake.operatorJobs.push(job);
      const txHash =
        `0x${fake.operatorJobs.length.toString(16).padStart(64, "0")}` as Hex;
      mined.set(
        txHash,
        fake.minesWrongHash
          ? (`0x${"f0".repeat(32)}` as Hex)
          : computeReceiptHash(receiptFromParams(job.params)),
      );
      return txHash;
    },
    receiptHashesFromTx: async (txHash) => {
      if (fake.receiptWaitThrows) throw new Error("receipt wait timed out");
      const hash = mined.get(txHash);
      if (hash === undefined) throw new Error("unknown tx");
      return [hash];
    },
    receiptIssued: async (hash) => fake.issuedOnChain.has(hash),
    pendingWaitMs: 20,
    payerEvmAddress: async (accountId) =>
      accountId === fake.payerAccount ? fake.payerEvm : undefined,
    now: () => fake.now,
    randomNonce: () => `0x${"51".repeat(32)}`,
  };
  const graph: GraphFetch = async () => {
    if (fake.graphThrows) throw new Error("boom");
    return fake.graphResult as never;
  };
  return {
    env,
    db,
    release,
    settle,
    graph,
    ipfsGateway: "https://ipfs.invalid",
    resolveAsset,
    fetchManifest: async () => asset.manifest,
    fetchBytes: async () => fake.contentBlob,
    agent: {
      wallet: () => ({
        address: fake.agentWallet.address,
        signTypedData: (td) => {
          fake.signCalls += 1;
          return fake.agentWallet.signTypedData(td);
        },
        signRawHash: (hash) => {
          fake.signCalls += 1;
          return fake.agentWallet.signRawHash(hash);
        },
      }),
      accountId: async () => fake.agentAccountId,
    },
    get mcpSpendCapTinybar() {
      return fake.spendCap;
    },
    creatorOf: async () => fake.creator,
    licenseEpoch: async () => fake.licenseEpoch,
    bumpLicenseEpoch: async (input) => {
      fake.bumps.push(input);
      return `0x${"b1".repeat(32)}`;
    },
    waitForTx: async () => {},
    now: () => fake.now,
  };
}

export function createFake(): Fake {
  return {
    licenseEpoch: 0n,
    accessEpoch: 1n,
    tokenOwner: owner.address,
    creator: creator.address,
    verifyOk: true,
    payerAccount: PAYER_ACCOUNT,
    payerEvm: buyer.address,
    operatorJobs: [],
    bumps: [],
    graphResult: { data: { rightsTokens: [] } },
    graphThrows: false,
    consumeCalls: 0,
    mode: "custodial",
    settlementAccountId: "0.0.9999",
    settleCalls: 0,
    operatorConflict: false,
    issuedOnChain: new Set(),
    minesWrongHash: false,
    settleThrows: false,
    settleThrowsAppError: false,
    settleRejects: false,
    settleDelayMs: 0,
    receiptWaitThrows: false,
    now: NOW,
    feePayer: "0.0.777",
    contentBlob: new Uint8Array(),
    agentWallet: createLocalAgentWallet(`0x${"b7".repeat(32)}`),
    agentAccountId: PAYER_ACCOUNT,
    spendCap: 100_000_000_000n,
    signCalls: 0,
  };
}
