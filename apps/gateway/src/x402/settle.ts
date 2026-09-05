import {
  buildDomain,
  computePurchaseRequestHash,
  computeReceiptHash,
  type Deployment,
  manifestPolicyHash,
  manifestToPolicyInput,
  type RightsReceipt,
  TransferMode,
} from "@truenft/shared";
import { and, eq } from "drizzle-orm";
import { type Address, bytesToHex, type Hex, isAddressEqual } from "viem";
import { denyOutcome, writeAudit } from "../audit/log";
import { type PaymentStatus, paymentBinding } from "../db/schema";
import type { Db } from "../db/types";
import { isUniqueViolation } from "../db/types";
import type { ReceiptParamsJson } from "../do/operatorQueueCore";
import type { Env, SettlementMode } from "../env";
import { AppError } from "../errors";
import type { ResolvedAsset } from "../manifest/resolver";
import { signReceipt } from "../receipt/issue";
import {
  decodePaymentHeader,
  derivePaymentId,
  type FacilitatorClient,
  HBAR_ASSET_ID,
  HEDERA_TESTNET_NETWORK,
  PAID_ACCESS_PLAN_ID,
  type PaymentRequirements,
  X402_VERSION,
} from "./facilitator";

/**
 * x402 settlement orchestration (tasks.md T088, gateway-api.md "購入者パス"). Chain reads,
 * the facilitator and the operator queue are injected so the payment_binding state machine
 * (R-10) and the receipt binding can be exercised without a relay.
 */
type QuoteReads = {
  licenseEpoch: bigint;
  accessEpoch: bigint;
  policyHash: Hex;
  resourceHash: Hex;
};

type OperatorSettleJob = {
  kind: "settleAndIssue";
  params: ReceiptParamsJson;
  valueWeibar: string;
  idempotencyKey: string;
};

type OperatorFinalizeJob = {
  kind: "finalize";
  paymentId: Hex;
  params: ReceiptParamsJson;
  idempotencyKey: string;
};

export type SettlePorts = {
  env: Env;
  db: Db;
  deployment: Deployment;
  mode: SettlementMode;
  /** Hedera account that receives custodial transfers (custodial rail only) */
  settlementAccountId: string;
  facilitator: FacilitatorClient;
  resolveAsset(assetId: Hex): Promise<ResolvedAsset>;
  quoteReads(tokenId: bigint): Promise<QuoteReads>;
  /** submits settleAndIssue / finalize through OperatorTxQueue, returns the tx hash */
  operator(job: OperatorSettleJob | OperatorFinalizeJob): Promise<Hex>;
  /** waits for the settlement tx and returns the receiptHash from ReceiptIssued */
  receiptHashFromTx(txHash: Hex): Promise<Hex>;
  /** mirror node: payer account id -> EVM address */
  payerEvmAddress(accountId: string): Promise<Hex | undefined>;
  now(): Date;
  randomNonce(): Hex;
};

type PaymentAccept = PaymentRequirements & {
  extra: {
    settlementMode: SettlementMode;
    contractCall?: string;
    value: string;
    receiptQuote: ReceiptQuote;
  };
};

export type ReceiptQuote = {
  chainId: number;
  verifyingContract: Address;
  nftContract: Address;
  tokenId: string;
  resourceHash: Hex;
  policyHash: Hex;
  licenseEpoch: string;
  ownerEpochAtIssue: string;
  permittedAction: number;
  transferMode: 0 | 1;
  maxUses: number;
  issuedAt: number;
  expiresAt: number;
  priceTinybar: string;
  creatorBps: number;
  ownerBps: number;
};

export type PaymentRequired = {
  x402Version: number;
  accepts: PaymentAccept[];
  manifest: ResolvedAsset["manifest"];
};

const RESOURCE_PATH = (assetId: Hex): string => `/assets/${assetId}/paid`;

type QuoteTerms = Omit<ReceiptQuote, "issuedAt" | "expiresAt">;

/** Everything a quote fixes except the time window, re-read from the chain each time. */
async function currentQuoteTerms(
  ports: SettlePorts,
  asset: ResolvedAsset,
): Promise<QuoteTerms> {
  const reads = await ports.quoteReads(asset.tokenId);
  const policy = manifestToPolicyInput(asset.manifest);
  return {
    chainId: ports.deployment.chainId,
    verifyingContract: ports.deployment.rightsRegistry,
    nftContract: asset.nftContract,
    tokenId: asset.tokenId.toString(),
    resourceHash: reads.resourceHash,
    policyHash: reads.policyHash,
    licenseEpoch: reads.licenseEpoch.toString(),
    ownerEpochAtIssue: reads.accessEpoch.toString(),
    permittedAction: policy.permittedAction,
    transferMode: policy.transferMode as 0 | 1,
    maxUses: policy.maxUses,
    priceTinybar: policy.priceTinybar.toString(),
    creatorBps: policy.creatorBps,
    ownerBps: policy.ownerBps,
  };
}

/** 402 body: the quote fixes every receipt field the buyer does not choose. */
export async function buildPaymentRequired(
  ports: SettlePorts,
  assetId: Hex,
): Promise<PaymentRequired> {
  const asset = await ports.resolveAsset(assetId);
  const base = await currentQuoteTerms(ports, asset);
  if (manifestPolicyHash(asset.manifest) !== base.policyHash) {
    throw new AppError("POLICY_HASH_MISMATCH");
  }
  const issuedAt = Math.floor(ports.now().getTime() / 1000);
  const quote: ReceiptQuote = {
    ...base,
    issuedAt,
    expiresAt: issuedAt + asset.manifest.paidAccess.durationSec,
  };
  const value = asset.manifest.paidAccess.price; // weibar
  const accept: PaymentAccept = {
    scheme: "exact",
    network: HEDERA_TESTNET_NETWORK,
    asset: HBAR_ASSET_ID,
    maxAmountRequired: value,
    payTo:
      ports.mode === "custodial"
        ? ports.settlementAccountId
        : ports.deployment.rightsRegistry,
    resource: RESOURCE_PATH(assetId),
    description: `TrueCollective paid access to ${assetId}`,
    maxTimeoutSeconds: 600,
    extra: {
      settlementMode: ports.mode,
      ...(ports.mode === "primary" ? { contractCall: "settleAndIssue" } : {}),
      value,
      receiptQuote: quote,
    },
  };
  return {
    x402Version: X402_VERSION,
    accepts: [accept],
    manifest: asset.manifest,
  };
}

export type SettleInput = {
  assetId: Hex;
  /** raw X-PAYMENT header (base64 JSON) */
  xPayment: string;
  /** EVM address of the buyer (must be the payer of the signed payload) */
  licensee: Address;
  /** the quote the client accepted (echoed from the 402) */
  quote: ReceiptQuote;
};

export type SettleOutput = {
  receiptHash: Hex;
  receipt: RightsReceipt;
  serverSignature: Hex;
  onchainTx: string;
  maxUses: number;
  expiresAt: number;
  settlementMode: SettlementMode;
};

function toParams(
  receipt: RightsReceipt,
  quote: ReceiptQuote,
): ReceiptParamsJson {
  return {
    nftContract: receipt.nftContract,
    tokenId: receipt.tokenId.toString(),
    resourceHash: receipt.resourceHash,
    policyHash: receipt.policyHash,
    licenseEpoch: receipt.licenseEpoch.toString(),
    ownerEpochAtIssue: receipt.ownerEpochAtIssue.toString(),
    licensee: receipt.licensee,
    permittedAction: receipt.permittedAction,
    transferMode: receipt.transferMode,
    maxUses: receipt.maxUses,
    expiresAt: receipt.expiresAt.toString(),
    purchaseRequestHash: receipt.purchaseRequestHash,
    paymentId: receipt.paymentId,
    nonce: receipt.nonce,
    issuedAt: receipt.issuedAt.toString(),
    price: quote.priceTinybar,
    creatorBps: quote.creatorBps,
    ownerBps: quote.ownerBps,
  };
}

/** The quote must still describe the asset (chain re-read) - the buyer cannot pick stale terms. */
async function assertQuoteCurrent(
  ports: SettlePorts,
  asset: ResolvedAsset,
  quote: ReceiptQuote,
): Promise<void> {
  const expected = await currentQuoteTerms(ports, asset);
  if (quote.chainId !== expected.chainId)
    throw new AppError("CHAIN_ID_MISMATCH");
  if (
    quote.policyHash !== expected.policyHash ||
    quote.priceTinybar !== expected.priceTinybar ||
    quote.maxUses !== expected.maxUses ||
    quote.permittedAction !== expected.permittedAction ||
    quote.transferMode !== expected.transferMode ||
    quote.creatorBps !== expected.creatorBps ||
    quote.ownerBps !== expected.ownerBps
  ) {
    throw new AppError(
      "POLICY_HASH_MISMATCH",
      "quote does not match the current policy",
    );
  }
  if (
    quote.resourceHash !== expected.resourceHash ||
    quote.tokenId !== expected.tokenId ||
    !isAddressEqual(quote.nftContract, expected.nftContract) ||
    !isAddressEqual(quote.verifyingContract, expected.verifyingContract)
  ) {
    throw new AppError(
      "RESOURCE_HASH_MISMATCH",
      "quote does not match the asset",
    );
  }
  if (quote.licenseEpoch !== expected.licenseEpoch) {
    throw new AppError(
      "LICENSE_EPOCH_MISMATCH",
      "quote is from a previous license epoch",
    );
  }
  if (quote.ownerEpochAtIssue !== expected.ownerEpochAtIssue) {
    throw new AppError(
      "OWNER_EPOCH_MISMATCH",
      "the NFT was transferred since the quote",
    );
  }
  if (
    quote.expiresAt - quote.issuedAt !==
    asset.manifest.paidAccess.durationSec
  ) {
    throw new AppError("EXPIRY_MISMATCH");
  }
  const nowSec = Math.floor(ports.now().getTime() / 1000);
  if (quote.issuedAt > nowSec + 60 || nowSec - quote.issuedAt > 600) {
    throw new AppError(
      "EXPIRY_MISMATCH",
      "quote issuedAt outside the issuance window",
    );
  }
}

type BindingRow = typeof paymentBinding.$inferSelect;

async function readBinding(
  db: Db,
  paymentId: Hex,
): Promise<BindingRow | undefined> {
  const [row] = await db
    .select()
    .from(paymentBinding)
    .where(eq(paymentBinding.paymentId, paymentId))
    .limit(1);
  return row;
}

async function setBinding(
  db: Db,
  paymentId: Hex,
  status: PaymentStatus,
  receiptHash?: Hex,
): Promise<void> {
  await db
    .update(paymentBinding)
    .set({ status, receiptHash })
    .where(eq(paymentBinding.paymentId, paymentId));
}

/** R-10 / gateway-api.md step 1: claim the paymentId or answer from the existing binding. */
async function claimPayment(
  ports: SettlePorts,
  paymentId: Hex,
  purchaseRequestHash: Hex,
  amountTinybar: bigint,
): Promise<"claimed" | { settled: Hex }> {
  try {
    await ports.db.insert(paymentBinding).values({
      paymentId,
      purchaseRequestHash,
      amount: amountTinybar,
      status: "pending",
    });
    return "claimed";
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const row = await readBinding(ports.db, paymentId);
    if (row === undefined) throw new AppError("SETTLEMENT_IN_PROGRESS");
    if (row.purchaseRequestHash !== purchaseRequestHash) {
      throw new AppError("PAYMENT_ID_PAYLOAD_CONFLICT");
    }
    if (row.status === "settled" && row.receiptHash !== null) {
      return { settled: row.receiptHash };
    }
    if (row.status === "failed") {
      // previous attempt failed definitively: this request re-tries the settlement
      const [reclaimed] = await ports.db
        .update(paymentBinding)
        .set({ status: "pending" })
        .where(
          and(
            eq(paymentBinding.paymentId, paymentId),
            eq(paymentBinding.status, "failed"),
          ),
        )
        .returning({ paymentId: paymentBinding.paymentId });
      if (reclaimed !== undefined) return "claimed";
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new AppError("SETTLEMENT_IN_PROGRESS");
}

/** POST /assets/:assetId/paid (X-PAYMENT): steps 1-7 of gateway-api.md. */
export async function settlePayment(
  ports: SettlePorts,
  input: SettleInput,
): Promise<SettleOutput> {
  if (ports.mode === "fallback") {
    throw new AppError(
      "SETTLEMENT_NOT_FINALIZED",
      "fallback rail: pay with payFor{value} on chain, then POST /assets/{assetId}/finalize",
    );
  }
  const asset = await ports.resolveAsset(input.assetId);
  await assertQuoteCurrent(ports, asset, input.quote);
  const { payload, raw } = decodePaymentHeader(input.xPayment);
  if (
    payload.network !== HEDERA_TESTNET_NETWORK ||
    payload.scheme !== "exact"
  ) {
    throw new AppError(
      "CHAIN_ID_MISMATCH",
      "payment is not hedera:testnet/exact",
    );
  }
  const paymentId = derivePaymentId(raw);
  const purchaseRequestHash = computePurchaseRequestHash({
    httpMethod: "POST",
    path: RESOURCE_PATH(input.assetId),
    planId: PAID_ACCESS_PLAN_ID,
    resourceHash: input.quote.resourceHash,
    policyHash: input.quote.policyHash,
  });
  const priceTinybar = BigInt(input.quote.priceTinybar);
  const receipt: RightsReceipt = {
    chainId: BigInt(input.quote.chainId),
    verifyingContract: input.quote.verifyingContract,
    nftContract: input.quote.nftContract,
    tokenId: BigInt(input.quote.tokenId),
    resourceHash: input.quote.resourceHash,
    policyHash: input.quote.policyHash,
    licenseEpoch: BigInt(input.quote.licenseEpoch),
    ownerEpochAtIssue: BigInt(input.quote.ownerEpochAtIssue),
    licensee: input.licensee,
    permittedAction: input.quote.permittedAction,
    transferMode:
      input.quote.transferMode === 1
        ? TransferMode.INVALIDATE_ON_TRANSFER
        : TransferMode.SURVIVE_TRANSFER,
    maxUses: input.quote.maxUses,
    expiresAt: BigInt(input.quote.expiresAt),
    purchaseRequestHash,
    paymentId,
    nonce: ports.randomNonce(),
    issuedAt: BigInt(input.quote.issuedAt),
  };

  const subject = {
    assetId: input.assetId,
    tokenId: asset.tokenId.toString(),
    paymentId,
    licensee: input.licensee,
  };
  const deny = async (code: AppError["code"]): Promise<void> => {
    await writeAudit(ports.db, {
      actor: input.licensee,
      action: "deny",
      subject: { ...subject, attempted: "x402_settle" },
      outcome: denyOutcome(code),
    });
  };

  const claim = await claimPayment(
    ports,
    paymentId,
    purchaseRequestHash,
    priceTinybar,
  );
  if (claim !== "claimed") {
    // idempotent replay of a settled payment: the receipt was already issued for this payload
    return replaySettled(ports, asset, claim.settled, receipt);
  }

  try {
    const requirements = requirementsFor(ports, input, asset);
    const verified = await ports.facilitator.verify(payload, requirements);
    if (!verified.isValid) {
      throw new AppError(
        "UNDERPAYMENT",
        `facilitator rejected the payment: ${verified.invalidReason ?? "invalid"}`,
      );
    }
    if (verified.payer !== undefined) {
      const payerEvm = await ports.payerEvmAddress(verified.payer);
      if (payerEvm === undefined || !isAddressEqual(payerEvm, input.licensee)) {
        throw new AppError(
          "LICENSEE_MISMATCH",
          "licensee is not the payer of the signed payment",
        );
      }
    }
    const settled = await ports.facilitator.settle(payload, requirements);
    if (!settled.success) {
      throw new AppError(
        "UNDERPAYMENT",
        `facilitator could not settle: ${settled.errorReason ?? "failed"}`,
      );
    }
    let onchainTx: string = settled.transaction;
    let receiptHash: Hex;
    if (ports.mode === "primary") {
      // the facilitator submitted settleAndIssue{value}; the ReceiptIssued log carries the hash
      receiptHash = await ports.receiptHashFromTx(settled.transaction as Hex);
    } else {
      // custodial: HBAR landed on the settlement account; the operator anchors the receipt
      const txHash = await ports.operator({
        kind: "settleAndIssue",
        params: toParams(receipt, input.quote),
        valueWeibar: (priceTinybar * 10_000_000_000n).toString(),
        idempotencyKey: `settle:${paymentId}`,
      });
      receiptHash = await ports.receiptHashFromTx(txHash);
      onchainTx = txHash;
    }
    const expectedHash = computeReceiptHash(receipt);
    if (receiptHash !== expectedHash) {
      throw new AppError(
        "COMMITTED_PARAMS_MISMATCH",
        "on-chain receiptHash differs from the quoted receipt",
        { expected: expectedHash, onchain: receiptHash },
      );
    }
    await setBinding(ports.db, paymentId, "settled", receiptHash);
    const serverSignature = await signReceipt(
      ports.env,
      buildDomain(ports.deployment.rightsRegistry, ports.deployment.chainId),
      receipt,
    );
    await writeAudit(ports.db, {
      actor: input.licensee,
      action: "x402_settle",
      subject: { ...subject, receiptHash, settlementMode: ports.mode },
      outcome: "allow",
      onchainRef: onchainTx.startsWith("0x") ? (onchainTx as Hex) : undefined,
    });
    return {
      receiptHash,
      receipt,
      serverSignature,
      onchainTx,
      maxUses: receipt.maxUses,
      expiresAt: Number(receipt.expiresAt),
      settlementMode: ports.mode,
    };
  } catch (error) {
    await setBinding(ports.db, paymentId, "failed");
    if (error instanceof AppError) await deny(error.code);
    throw error;
  }
}

function requirementsFor(
  ports: SettlePorts,
  input: SettleInput,
  asset: ResolvedAsset,
): PaymentRequirements {
  return {
    scheme: "exact",
    network: HEDERA_TESTNET_NETWORK,
    asset: HBAR_ASSET_ID,
    maxAmountRequired: asset.manifest.paidAccess.price,
    payTo:
      ports.mode === "custodial"
        ? ports.settlementAccountId
        : ports.deployment.rightsRegistry,
    resource: RESOURCE_PATH(input.assetId),
    maxTimeoutSeconds: 600,
    extra: {
      settlementMode: ports.mode,
      value: asset.manifest.paidAccess.price,
      receiptQuote: input.quote,
    },
  };
}

async function replaySettled(
  ports: SettlePorts,
  _asset: ResolvedAsset,
  receiptHash: Hex,
  receipt: RightsReceipt,
): Promise<SettleOutput> {
  // The stored receiptHash was produced from the same signed payload; the nonce it was issued
  // with is not recoverable here, so the replay returns the hash + a fresh server signature
  // over the reconstructed receipt only when the hashes agree (they do when nonce is stable).
  const serverSignature = await signReceipt(
    ports.env,
    buildDomain(ports.deployment.rightsRegistry, ports.deployment.chainId),
    receipt,
  );
  return {
    receiptHash,
    receipt,
    serverSignature,
    onchainTx: "replay",
    maxUses: receipt.maxUses,
    expiresAt: Number(receipt.expiresAt),
    settlementMode: ports.mode,
  };
}

/** POST /assets/:assetId/finalize (fallback rail, R-2a): operator submits finalize(paymentId, p). */
export async function finalizeDeposit(
  ports: SettlePorts,
  input: {
    assetId: Hex;
    paymentId: Hex;
    receipt: RightsReceipt;
    quote: ReceiptQuote;
  },
): Promise<SettleOutput> {
  if (ports.mode !== "fallback") {
    throw new AppError(
      "NOT_AUTHORIZED",
      "finalize is only available on the fallback rail",
    );
  }
  const asset = await ports.resolveAsset(input.assetId);
  if (input.receipt.tokenId !== asset.tokenId) {
    throw new AppError("RESOURCE_HASH_MISMATCH");
  }
  const txHash = await ports.operator({
    kind: "finalize",
    paymentId: input.paymentId,
    params: toParams(input.receipt, input.quote),
    idempotencyKey: `finalize:${input.paymentId}`,
  });
  const receiptHash = await ports.receiptHashFromTx(txHash);
  if (receiptHash !== computeReceiptHash(input.receipt)) {
    throw new AppError("COMMITTED_PARAMS_MISMATCH");
  }
  const serverSignature = await signReceipt(
    ports.env,
    buildDomain(ports.deployment.rightsRegistry, ports.deployment.chainId),
    input.receipt,
  );
  await writeAudit(ports.db, {
    actor: input.receipt.licensee,
    action: "x402_settle",
    subject: {
      assetId: input.assetId,
      paymentId: input.paymentId,
      receiptHash,
      settlementMode: "fallback",
    },
    outcome: "allow",
    onchainRef: txHash,
  });
  return {
    receiptHash,
    receipt: input.receipt,
    serverSignature,
    onchainTx: txHash,
    maxUses: input.receipt.maxUses,
    expiresAt: Number(input.receipt.expiresAt),
    settlementMode: "fallback",
  };
}

export function randomNonce(): Hex {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
}
