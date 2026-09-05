import { type RightsReceipt, TransferMode } from "@truenft/shared";
import type { Hono } from "hono";
import { z } from "zod";
import { AppError } from "../errors";
import { AssetNotFoundError } from "../manifest/resolver";
import { decodePaymentHeader } from "../x402/facilitator";
import {
  buildPaymentRequired,
  finalizeDeposit,
  type ReceiptQuote,
  settlePayment,
} from "../x402/settle";
import {
  type AppEnv,
  address,
  badRequest,
  hex32,
  jsonSafe,
  notFound,
  parseAssetId,
  parseBody,
  uintString,
} from "./schemas";

/**
 * Buyer path (tasks.md T088, gateway-api.md "購入者パス"): 402 quote, X-PAYMENT settlement
 * (payment_binding idempotency, R-10) and the fallback-rail finalize.
 */
const QuoteSchema = z.object({
  chainId: z.number().int(),
  verifyingContract: address,
  nftContract: address,
  tokenId: uintString,
  resourceHash: hex32,
  policyHash: hex32,
  licenseEpoch: uintString,
  ownerEpochAtIssue: uintString,
  permittedAction: z.number().int().min(0).max(255),
  transferMode: z.union([z.literal(0), z.literal(1)]),
  maxUses: z.number().int().min(1),
  issuedAt: z.number().int().min(0),
  expiresAt: z.number().int().min(0),
  priceTinybar: uintString,
  creatorBps: z.number().int().min(0).max(10_000),
  ownerBps: z.number().int().min(0).max(10_000),
  nonce: hex32,
});

const SettleBody = z.object({
  paymentPayload: z.string().max(65_536).optional(),
  licensee: address,
});

const ReceiptSchema = z.object({
  chainId: z.number().int(),
  verifyingContract: address,
  nftContract: address,
  tokenId: uintString,
  resourceHash: hex32,
  policyHash: hex32,
  licenseEpoch: uintString,
  ownerEpochAtIssue: uintString,
  licensee: address,
  permittedAction: z.number().int().min(0).max(255),
  transferMode: z.union([z.literal(0), z.literal(1)]),
  maxUses: z.number().int().min(1),
  expiresAt: z.number().int().min(0),
  purchaseRequestHash: hex32,
  paymentId: hex32,
  nonce: hex32,
  issuedAt: z.number().int().min(0),
});

const FinalizeBody = z.object({
  paymentId: hex32,
  receipt: ReceiptSchema,
  price: uintString,
  creatorBps: z.number().int().min(0).max(10_000),
  ownerBps: z.number().int().min(0).max(10_000),
});

function withNotFound<T>(run: () => Promise<T>): Promise<T> {
  return run().catch((error: unknown) => {
    if (error instanceof AssetNotFoundError) throw notFound("unknown asset");
    throw error;
  });
}

export function registerX402Routes(app: Hono<AppEnv>): void {
  app.get("/assets/:assetId/paid", async (c) => {
    const services = c.get("services");
    const assetId = parseAssetId(c);
    const required = await withNotFound(() =>
      buildPaymentRequired(services.settle, assetId),
    );
    return c.json(required, 402);
  });

  app.post("/assets/:assetId/paid", async (c) => {
    const services = c.get("services");
    const assetId = parseAssetId(c);
    const body = await parseBody(c, SettleBody);
    const xPayment = c.req.header("X-PAYMENT") ?? body.paymentPayload;
    if (xPayment === undefined) {
      throw new AppError("UNDERPAYMENT", "missing X-PAYMENT payment payload");
    }
    // the buyer signed the requirements it accepted; the quote travels inside them
    const { payload } = decodePaymentHeader(xPayment);
    const quote = QuoteSchema.safeParse(payload.accepted?.extra?.receiptQuote);
    if (!quote.success) {
      throw new AppError(
        "UNDERPAYMENT",
        "payment payload does not carry the accepted receiptQuote",
      );
    }
    const feePayer = payload.accepted?.extra?.feePayer;
    const settled = await withNotFound(() =>
      settlePayment(services.settle, {
        assetId,
        xPayment,
        licensee: body.licensee,
        quote: quote.data as ReceiptQuote,
        ...(typeof feePayer === "string" ? { feePayer } : {}),
      }),
    );
    return c.json(jsonSafe(settled));
  });

  app.post("/assets/:assetId/finalize", async (c) => {
    const services = c.get("services");
    const assetId = parseAssetId(c);
    const body = await parseBody(c, FinalizeBody);
    if (body.creatorBps + body.ownerBps !== 10_000) {
      throw badRequest("creatorBps + ownerBps must be 10000");
    }
    const r = body.receipt;
    const receipt: RightsReceipt = {
      chainId: BigInt(r.chainId),
      verifyingContract: r.verifyingContract,
      nftContract: r.nftContract,
      tokenId: BigInt(r.tokenId),
      resourceHash: r.resourceHash,
      policyHash: r.policyHash,
      licenseEpoch: BigInt(r.licenseEpoch),
      ownerEpochAtIssue: BigInt(r.ownerEpochAtIssue),
      licensee: r.licensee,
      permittedAction: r.permittedAction,
      transferMode:
        r.transferMode === 1
          ? TransferMode.INVALIDATE_ON_TRANSFER
          : TransferMode.SURVIVE_TRANSFER,
      maxUses: r.maxUses,
      expiresAt: BigInt(r.expiresAt),
      purchaseRequestHash: r.purchaseRequestHash,
      paymentId: r.paymentId,
      nonce: r.nonce,
      issuedAt: BigInt(r.issuedAt),
    };
    const quote: ReceiptQuote = {
      chainId: r.chainId,
      verifyingContract: r.verifyingContract,
      nftContract: r.nftContract,
      tokenId: r.tokenId,
      resourceHash: r.resourceHash,
      policyHash: r.policyHash,
      licenseEpoch: r.licenseEpoch,
      ownerEpochAtIssue: r.ownerEpochAtIssue,
      permittedAction: r.permittedAction,
      transferMode: r.transferMode,
      maxUses: r.maxUses,
      issuedAt: r.issuedAt,
      expiresAt: r.expiresAt,
      priceTinybar: body.price,
      creatorBps: body.creatorBps,
      ownerBps: body.ownerBps,
      nonce: r.nonce,
    };
    const settled = await withNotFound(() =>
      finalizeDeposit(services.settle, {
        assetId,
        paymentId: body.paymentId,
        receipt,
        quote,
      }),
    );
    return c.json(jsonSafe(settled));
  });
}
