import type { RightsReceipt } from "@truenft/shared";
import type { Hex } from "viem";
import { writeAudit } from "../../audit/log";
import { HEDERA_TESTNET_NETWORK, X402_VERSION } from "../../x402/facilitator";
import { buildPaymentRequired, settlePayment } from "../../x402/settle";
import type { McpContext } from "../context";
import { buildSignedTransfer } from "../hedera";
import {
  bindReceiptToSession,
  requireSession,
  sessionSpendTinybar,
} from "../session";
import { McpToolError } from "../toolError";

/**
 * `buy_access` (tasks.md T094, mcp-tools.md): quote -> agent-signed HBAR transfer ->
 * POST /assets/{assetId}/paid flow in-process -> receipt bound to this MCP session (R-9a).
 * The per-session hard cap is enforced BEFORE any signature is requested (R-9, SC-011).
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

  // spend policy (R-9): hard cap per Mcp-Session-Id, checked before signing anything
  const cap = services.mcpSpendCapTinybar;
  const spent = await sessionSpendTinybar(services.db, sessionId);
  if (spent + priceTinybar > cap) {
    throw new McpToolError(
      "SPEND_LIMIT_EXCEEDED",
      `session spent ${spent} tinybar, this purchase costs ${priceTinybar}, cap is ${cap}`,
    );
  }

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
  const settled = await settlePayment(services.settle, {
    assetId: input.assetId,
    xPayment,
    licensee: wallet.address,
    quote,
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
}
