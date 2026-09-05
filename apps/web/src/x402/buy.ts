import type { PaymentRequirements } from "@x402/core/types";
import type { ClientHederaSigner } from "@x402/hedera";
import {
  type Api,
  type PaymentAccept,
  type PaymentRequired,
  paymentRequirements,
  type SettleResponse,
  settlePayment,
} from "../api/client";
import { bytesToBase64 } from "../lib/encoding";

/**
 * Buyer flow (tasks.md T108, gateway-api.md 購入者パス): 402 quote -> the Privy-backed Hedera
 * signer produces the partially signed HBAR transfer -> X-PAYMENT -> Rights Receipt.
 */
export class InsufficientBalanceError extends Error {
  override readonly name = "InsufficientBalanceError";
  readonly balanceTinybars: bigint;
  readonly priceTinybars: bigint;
  constructor(balanceTinybars: bigint, priceTinybars: bigint) {
    super(
      `insufficient HBAR: balance ${balanceTinybars} tinybar, price ${priceTinybars} tinybar`,
    );
    this.balanceTinybars = balanceTinybars;
    this.priceTinybars = priceTinybars;
  }
}

const WEIBAR_PER_TINYBAR = 10_000_000_000n;

function priceTinybarsOf(accept: PaymentAccept): bigint {
  return BigInt(accept.maxAmountRequired) / WEIBAR_PER_TINYBAR;
}

export function assertAffordable(
  balanceTinybars: bigint,
  accept: PaymentAccept,
): void {
  const price = priceTinybarsOf(accept);
  if (balanceTinybars < price) {
    throw new InsufficientBalanceError(balanceTinybars, price);
  }
}

/** The requirements the signer builds the transfer from: v2 `amount` is tinybar. */
export function toSignerRequirements(
  accept: PaymentAccept,
): PaymentRequirements {
  return {
    scheme: "exact",
    network: accept.network as PaymentRequirements["network"],
    asset: accept.asset,
    amount: priceTinybarsOf(accept).toString(),
    payTo: accept.payTo,
    maxTimeoutSeconds: accept.maxTimeoutSeconds ?? 600,
    extra: accept.extra ?? {},
  };
}

/** X-PAYMENT header value: base64(JSON x402 v2 payload echoing the accepted requirements). */
export function encodePaymentHeader(
  accept: PaymentAccept,
  transaction: string,
): string {
  const payload = {
    x402Version: 2,
    scheme: "exact",
    network: accept.network,
    payload: { transaction },
    accepted: accept,
  };
  return bytesToBase64(new TextEncoder().encode(JSON.stringify(payload)));
}

export type BuyResult = {
  required: PaymentRequired;
  accept: PaymentAccept;
  settled: SettleResponse;
};

export async function buyAccess(input: {
  api: Api;
  signer: ClientHederaSigner;
  licensee: `0x${string}`;
  assetId: `0x${string}`;
  balanceTinybars?: bigint;
}): Promise<BuyResult> {
  const required = await paymentRequirements(input.api, input.assetId);
  const accept = required.accepts[0];
  if (accept === undefined) {
    throw new Error("gateway offered no payment option");
  }
  if (input.balanceTinybars !== undefined) {
    assertAffordable(input.balanceTinybars, accept);
  }
  const transaction =
    await input.signer.createPartiallySignedTransferTransaction(
      toSignerRequirements(accept),
    );
  const settled = await settlePayment(
    input.api,
    input.assetId,
    encodePaymentHeader(accept, transaction),
    input.licensee,
  );
  return { required, accept, settled };
}
