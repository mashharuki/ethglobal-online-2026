import { type Hex, keccak256, stringToHex } from "viem";
import { AppError } from "../errors";

/**
 * Blocky402 facilitator client (tasks.md T084, research.md R-2 / R-2a). Speaks x402 v2 JSON
 * over HTTP (`/supported`, `/verify`, `/settle`) with a plain `fetch` so it runs unchanged in
 * workerd. Payload shapes are the x402 v2 wire format; the Hedera `exact` scheme carries a
 * base64 HAPI transaction (`payload.transaction`) and the facilitator submits it as feePayer.
 *
 * Which rail the gateway runs is `SETTLEMENT_MODE` (research.md R-2a):
 * - primary   : value-attached ContractCall to settleAndIssue verified + settled by Blocky402
 *               (depends on the day1 probe T020 - the @x402/hedera exact scheme flags
 *               non-transfer operations, so this is NOT expected to be accepted)
 * - custodial : plain HBAR transfer to the gateway settlement account; after the facilitator
 *               settles it the operator submits settleAndIssue{value} (non-atomic, disclosed)
 * - fallback  : buyer calls payFor{value} on chain; /finalize submits finalize(paymentId, p)
 */
export const HEDERA_TESTNET_NETWORK = "hedera:testnet";
/** x402 asset id for native HBAR (@x402/hedera HBAR_ASSET_ID) */
export const HBAR_ASSET_ID = "0.0.0";
export const X402_VERSION = 2;

export type PaymentRequirements = {
  scheme: "exact";
  network: string;
  asset: string;
  maxAmountRequired: string;
  payTo: string;
  resource: string;
  description?: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
};

export type PaymentPayload = {
  x402Version: number;
  scheme: string;
  network: string;
  payload: Record<string, unknown>;
  accepted?: PaymentRequirements;
};

type VerifyResponse = {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
};

type SettleResponse = {
  success: boolean;
  errorReason?: string;
  payer?: string;
  transaction: string;
  network: string;
};

type SupportedResponse = {
  kinds: Array<{
    x402Version: number;
    scheme: string;
    network: string;
    extra?: Record<string, unknown>;
  }>;
};

export type FacilitatorClient = {
  supported(): Promise<SupportedResponse>;
  verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse>;
  settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse>;
};

async function postJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  body: unknown,
): Promise<T> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(
      `facilitator ${new URL(url).pathname} answered ${response.status}`,
    );
  }
  return (await response.json()) as T;
}

export function createFacilitatorClient(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): FacilitatorClient {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return {
    supported: async () => {
      const response = await fetchImpl(`${base}/supported`);
      if (!response.ok) {
        throw new Error(`facilitator /supported answered ${response.status}`);
      }
      return (await response.json()) as SupportedResponse;
    },
    verify: (paymentPayload, paymentRequirements) =>
      postJson<VerifyResponse>(fetchImpl, `${base}/verify`, {
        x402Version: X402_VERSION,
        paymentPayload,
        paymentRequirements,
      }),
    settle: (paymentPayload, paymentRequirements) =>
      postJson<SettleResponse>(fetchImpl, `${base}/settle`, {
        x402Version: X402_VERSION,
        paymentPayload,
        paymentRequirements,
      }),
  };
}

/** X-PAYMENT header: base64(JSON PaymentPayload). Returns the parsed payload + raw bytes. */
export function decodePaymentHeader(header: string): {
  payload: PaymentPayload;
  raw: Uint8Array;
} {
  let json: string;
  try {
    json = atob(header);
  } catch {
    throw new AppError("UNDERPAYMENT", "X-PAYMENT is not base64");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new AppError("UNDERPAYMENT", "X-PAYMENT is not JSON");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as PaymentPayload).scheme !== "string" ||
    typeof (parsed as PaymentPayload).network !== "string" ||
    typeof (parsed as PaymentPayload).payload !== "object"
  ) {
    throw new AppError(
      "UNDERPAYMENT",
      "X-PAYMENT is not an x402 payment payload",
    );
  }
  return {
    payload: parsed as PaymentPayload,
    raw: new TextEncoder().encode(json),
  };
}

/**
 * paymentId = keccak256(buyer-signed payload bytes) (R-10): deterministic from what the buyer
 * signed, available before settlement, never client-chosen.
 */
export function derivePaymentId(rawPayload: Uint8Array): Hex {
  return keccak256(rawPayload);
}

/** planId bound into purchaseRequestHash: the paid-access plan of the manifest (v1). */
export const PAID_ACCESS_PLAN_ID: Hex = keccak256(
  stringToHex("truenft/plan/paidAccess/v1"),
);

/** Mirror node lookup: Hedera account id -> EVM address (the licensee must be the payer). */
export async function resolvePayerEvmAddress(
  mirrorUrl: string,
  accountId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Hex | undefined> {
  if (!/^\d+\.\d+\.\d+$/.test(accountId)) return undefined;
  const base = mirrorUrl.endsWith("/") ? mirrorUrl.slice(0, -1) : mirrorUrl;
  const response = await fetchImpl(`${base}/api/v1/accounts/${accountId}`);
  if (!response.ok) return undefined;
  const body = (await response.json()) as { evm_address?: string };
  if (
    typeof body.evm_address !== "string" ||
    !/^0x[0-9a-fA-F]{40}$/.test(body.evm_address)
  ) {
    return undefined;
  }
  return body.evm_address as Hex;
}
