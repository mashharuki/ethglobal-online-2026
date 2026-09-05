import type { ErrorBody } from "@truenft/openapi";
import { ERROR_HTTP_STATUS, type ErrorCode } from "@truenft/shared";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/**
 * Gateway error model (tasks.md T070). `ErrorCode` and the HTTP status table live in
 * packages/shared (public contract, contracts/error-codes.md); this module only adds the
 * default human message, the `AppError` carrier and Hono's `onError` handler. The response
 * body is the openapi `Error` schema so the web / agent clients can rely on it.
 */
export const ERROR_MESSAGE: Readonly<Record<ErrorCode, string>> = {
  RECEIPT_ALREADY_CONSUMED:
    "This useIndex of the Rights Receipt was already consumed",
  RESOURCE_HASH_MISMATCH:
    "Receipt resourceHash does not match the requested asset",
  POLICY_HASH_MISMATCH: "Receipt policyHash does not match the current policy",
  CHAIN_ID_MISMATCH: "Signature or receipt is bound to a different chainId",
  LICENSEE_MISMATCH: "Caller is not the licensee of this Rights Receipt",
  RECEIPT_EXPIRED: "Rights Receipt has expired",
  USE_LIMIT_EXCEEDED: "Rights Receipt maxUses exhausted",
  UNDERPAYMENT: "Payment amount is below the policy price",
  PAYMENT_ID_PAYLOAD_CONFLICT:
    "paymentId was already bound to a different purchase payload",
  OWNER_EPOCH_MISMATCH:
    "Owner session was issued for a previous accessEpoch (NFT transferred)",
  LICENSE_INVALIDATED_ON_TRANSFER:
    "INVALIDATE_ON_TRANSFER receipt is void after the NFT transfer",
  LICENSE_EPOCH_MISMATCH:
    "Receipt licenseEpoch is stale (policy updated or revoked)",
  NONCE_INVALID_OR_EXPIRED:
    "Challenge nonce is unknown, expired or already used",
  SIGNATURE_INVALID: "Signature does not verify",
  NOT_CURRENT_OWNER: "Caller is not the current owner of the NFT",
  CONTRACT_WALLET_UNSUPPORTED: "Contract wallets are not supported (EOA only)",
  CONDITIONS_HASH_MISMATCH:
    "Manifest conditionsHash does not match the KeyGate conditions",
  SETTLEMENT_NOT_FINALIZED: "Payment is deposited but not yet finalized",
  MANIFEST_SCHEMA_INVALID: "Rights Manifest failed schema validation",
  RATE_LIMITED: "Too many requests",
  POLICY_CONTENT_MISMATCH:
    "Receipt policy fields do not re-derive to the on-chain policyHash",
  EXPIRY_MISMATCH:
    "Receipt expiresAt does not match issuedAt + policy duration",
  COMMITTED_PARAMS_MISMATCH:
    "Finalize params do not match the committed deposit",
  MCP_SESSION_MISMATCH:
    "This Rights Receipt was purchased by a different MCP session",
  SETTLEMENT_IN_PROGRESS:
    "A settlement for this paymentId is already in progress",
  NOT_AUTHORIZED: "Not authorized",
};

export class AppError extends Error {
  override readonly name = "AppError";
  readonly code: ErrorCode;
  readonly status: number;
  readonly detail: Record<string, unknown> | undefined;

  constructor(
    code: ErrorCode,
    message: string = ERROR_MESSAGE[code],
    detail?: Record<string, unknown>,
  ) {
    super(message);
    this.code = code;
    this.status = ERROR_HTTP_STATUS[code];
    this.detail = detail;
  }

  toBody(): ErrorBody {
    return this.detail === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, detail: this.detail };
  }
}

/**
 * Hono `onError`. `AppError` -> its status + openapi Error body. Anything else is an
 * operational failure: log name/message (never secrets) and answer 500 with a generic body
 * so stack traces and internal messages never reach clients (security.md).
 */
export function handleError(err: Error, c: Context): Response {
  if (err instanceof AppError) {
    return c.json(err.toBody(), err.status as ContentfulStatusCode);
  }
  if (err instanceof HTTPException) {
    return err.getResponse();
  }
  console.error("unhandled gateway error", {
    path: c.req.path,
    name: err.name,
    message: err.message,
  });
  return c.json({ error: "internal_error" }, 500);
}
