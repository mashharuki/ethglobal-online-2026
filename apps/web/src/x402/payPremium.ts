import { wrapFetchWithPayment, x402Client, x402HTTPClient } from "@x402/fetch";
import type { ClientHederaSigner } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";

export type PayPremiumResult = {
  body: unknown;
  settlement: unknown;
};

/**
 * Performs `GET {resourceServerUrl}/premium` through the x402 payment flow:
 * the first response is 402, the Hedera signer produces a partially-signed
 * transfer, and `@x402/fetch` retries with the `X-PAYMENT` header. Mirrors
 * `apps/client/src/index.ts`.
 */
export async function payPremium(
  signer: ClientHederaSigner,
  resourceServerUrl: string,
): Promise<PayPremiumResult> {
  const client = new x402Client().register(
    "hedera:*",
    new ExactHederaScheme(signer),
  );

  const url = new URL("/premium", resourceServerUrl);
  const response = await wrapFetchWithPayment(fetch, client)(url);

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Payment request failed (${response.status}): ${text}`);
  }

  const body = await response.json();

  let settlement: unknown = null;
  try {
    settlement = new x402HTTPClient(client).getPaymentSettleResponse((name) =>
      response.headers.get(name),
    );
  } catch {
    settlement = null;
  }

  return { body, settlement };
}
