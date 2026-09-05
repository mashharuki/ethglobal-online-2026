import type { RightsReceipt } from "@truenft/shared";
import type { Hex } from "viem";
import { writeAudit } from "../../audit/log";
import {
  derivePaymentId,
  HEDERA_TESTNET_NETWORK,
  X402_VERSION,
} from "../../x402/facilitator";
import {
  buildPaymentRequired,
  readBindingStatus,
  settlePayment,
} from "../../x402/settle";
import type { McpContext } from "../context";
import { buildSignedTransfer } from "../hedera";
import {
  bindReceiptToSession,
  releaseSpend,
  requireSession,
  reserveSpend,
} from "../session";
import { McpToolError } from "../toolError";

/**
 * `buy_access` (tasks.md T094, mcp-tools.md): quote -> agent-signed HBAR transfer ->
 * POST /assets/{assetId}/paid flow in-process -> receipt bound to this MCP session (R-9a).
 * The per-session hard cap is a ledger reservation taken atomically BEFORE any signature is
 * requested (R-9, SC-011); it is given back only when the payment provably never moved value
 * (nothing was submitted, or the binding says the facilitator rejected it).
 */
export type BuyAccessOutput = {
  receiptHash: Hex;
  receipt: RightsReceipt;
  serverSignature: Hex;
  onchainTx: string;
  maxUses: number;
  expiresAt: number;
};

const WEIBAR_PER_TINYBAR = 10_000_000_000n;

function base64Json(value: unknown): string {
  return btoa(JSON.stringify(value));
}

export async function buyAccess(
  ctx: McpContext,
  input: { assetId: Hex },
): Promise<BuyAccessOutput> {
  const sessionId = requireSession(ctx.sessionId);
  const { services } = ctx;
  const required = await buildPaymentRequired(services.settle, input.assetId);
  const accept = required.accepts[0];
  if (accept === undefined) throw new McpToolError("NO_PAYMENT_OPTION");
  const quote = accept.extra.receiptQuote;
  const priceTinybar = BigInt(quote.priceTinybar);

  // spend policy (R-9): reserve the price against the session cap before signing anything
  const cap = services.mcpSpendCapTinybar;
  if (!(await reserveSpend(services.db, sessionId, priceTinybar, cap))) {
    throw new McpToolError(
      "SPEND_LIMIT_EXCEEDED",
      `this purchase costs ${priceTinybar} tinybar; the session cap is ${cap}`,
    );
  }

  let paymentId: Hex | undefined;
  try {
    const feePayer = accept.extra.feePayer;
    if (typeof feePayer !== "string" || feePayer === "") {
      throw new McpToolError(
        "FACILITATOR_UNAVAILABLE",
        "facilitator did not advertise a fee payer for hedera:testnet",
      );
    }
    const wallet = services.agent.wallet();
    const payerAccountId = await services.agent.accountId();
    const transaction = await buildSignedTransfer(wallet, {
      payerAccountId,
      payTo: accept.payTo,
      amountTinybar: BigInt(accept.maxAmountRequired) / WEIBAR_PER_TINYBAR,
      feePayer,
    });
    const xPayment = base64Json({
      x402Version: X402_VERSION,
      scheme: "exact",
      network: HEDERA_TESTNET_NETWORK,
      payload: { transaction },
      accepted: accept,
    });
    paymentId = derivePaymentId(new TextEncoder().encode(atob(xPayment)));
    const settled = await settlePayment(services.settle, {
      assetId: input.assetId,
      xPayment,
      licensee: wallet.address,
      quote,
      feePayer,
    });
    await bindReceiptToSession(services.db, settled.receiptHash, sessionId);
    await writeAudit(services.db, {
      actor: wallet.address,
      action: "x402_settle",
      subject: {
        assetId: input.assetId,
        receiptHash: settled.receiptHash,
        channel: "mcp-agent",
      },
      outcome: "allow",
      onchainRef: settled.onchainTx.startsWith("0x")
        ? (settled.onchainTx as Hex)
        : undefined,
    });
    return {
      receiptHash: settled.receiptHash,
      receipt: settled.receipt,
      serverSignature: settled.serverSignature,
      onchainTx: settled.onchainTx,
      maxUses: settled.maxUses,
      expiresAt: settled.expiresAt,
    };
  } catch (error) {
    // the reservation is only given back when no value can have moved: no payment payload
    // was ever built, or the binding records a definitive facilitator rejection. Anything
    // else - unknown outcome (pending), a settled receipt whose binding failed, or a payload
    // whose binding is absent - keeps the budget (fail closed).
    const status =
      paymentId === undefined
        ? "unsubmitted"
        : await readBindingStatus(services.db, paymentId);
    if (status === "unsubmitted" || status === "failed") {
      await releaseSpend(services.db, sessionId, priceTinybar);
    }
    throw error;
  }
}
