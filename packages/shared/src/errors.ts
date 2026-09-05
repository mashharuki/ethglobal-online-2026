/**
 * ErrorCode - PUBLIC CONTRACT (specs/001-rights-runtime-mvp/contracts/error-codes.md).
 *
 * These identifiers are stable IDs consumed by tests, the demo, the Dashboard and the
 * HTTP API. Renaming any value is a breaking change. `packages/openapi/openapi.yaml`
 * only mirrors this list and `test/errorCodes.stability.test.ts` verifies the three
 * sources (this file, error-codes.md, Solidity custom errors) stay identical.
 */
export const ErrorCode = {
  // ---- §10.1 attack / abnormal matrix (12 unique rejection codes) ----
  RECEIPT_ALREADY_CONSUMED: "RECEIPT_ALREADY_CONSUMED",
  RESOURCE_HASH_MISMATCH: "RESOURCE_HASH_MISMATCH",
  POLICY_HASH_MISMATCH: "POLICY_HASH_MISMATCH",
  CHAIN_ID_MISMATCH: "CHAIN_ID_MISMATCH",
  LICENSEE_MISMATCH: "LICENSEE_MISMATCH",
  RECEIPT_EXPIRED: "RECEIPT_EXPIRED",
  USE_LIMIT_EXCEEDED: "USE_LIMIT_EXCEEDED",
  UNDERPAYMENT: "UNDERPAYMENT",
  PAYMENT_ID_PAYLOAD_CONFLICT: "PAYMENT_ID_PAYLOAD_CONFLICT",
  OWNER_EPOCH_MISMATCH: "OWNER_EPOCH_MISMATCH",
  LICENSE_INVALIDATED_ON_TRANSFER: "LICENSE_INVALIDATED_ON_TRANSFER",
  LICENSE_EPOCH_MISMATCH: "LICENSE_EPOCH_MISMATCH",
  // ---- auxiliary codes (guards on the happy path) ----
  NONCE_INVALID_OR_EXPIRED: "NONCE_INVALID_OR_EXPIRED",
  SIGNATURE_INVALID: "SIGNATURE_INVALID",
  NOT_CURRENT_OWNER: "NOT_CURRENT_OWNER",
  CONTRACT_WALLET_UNSUPPORTED: "CONTRACT_WALLET_UNSUPPORTED",
  CONDITIONS_HASH_MISMATCH: "CONDITIONS_HASH_MISMATCH",
  SETTLEMENT_NOT_FINALIZED: "SETTLEMENT_NOT_FINALIZED",
  MANIFEST_SCHEMA_INVALID: "MANIFEST_SCHEMA_INVALID",
  RATE_LIMITED: "RATE_LIMITED",
  POLICY_CONTENT_MISMATCH: "POLICY_CONTENT_MISMATCH",
  EXPIRY_MISMATCH: "EXPIRY_MISMATCH",
  COMMITTED_PARAMS_MISMATCH: "COMMITTED_PARAMS_MISMATCH",
  MCP_SESSION_MISMATCH: "MCP_SESSION_MISMATCH",
  SETTLEMENT_IN_PROGRESS: "SETTLEMENT_IN_PROGRESS",
  NOT_AUTHORIZED: "NOT_AUTHORIZED",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Row #12 of the matrix: a SURVIVE_TRANSFER receipt used after transfer must succeed. */
export const PAID_LICENSE_TRANSFER_OK = "PAID_LICENSE_TRANSFER_OK" as const;

/** HTTP status the Access Gateway returns for each code (error-codes.md). */
export const ERROR_HTTP_STATUS: Readonly<Record<ErrorCode, number>> = {
  RECEIPT_ALREADY_CONSUMED: 409,
  RESOURCE_HASH_MISMATCH: 403,
  POLICY_HASH_MISMATCH: 403,
  CHAIN_ID_MISMATCH: 403,
  LICENSEE_MISMATCH: 403,
  RECEIPT_EXPIRED: 403,
  USE_LIMIT_EXCEEDED: 403,
  UNDERPAYMENT: 402,
  PAYMENT_ID_PAYLOAD_CONFLICT: 409,
  OWNER_EPOCH_MISMATCH: 403,
  LICENSE_INVALIDATED_ON_TRANSFER: 403,
  LICENSE_EPOCH_MISMATCH: 403,
  NONCE_INVALID_OR_EXPIRED: 401,
  SIGNATURE_INVALID: 401,
  NOT_CURRENT_OWNER: 403,
  CONTRACT_WALLET_UNSUPPORTED: 400,
  CONDITIONS_HASH_MISMATCH: 403,
  SETTLEMENT_NOT_FINALIZED: 409,
  MANIFEST_SCHEMA_INVALID: 422,
  RATE_LIMITED: 429,
  POLICY_CONTENT_MISMATCH: 403,
  EXPIRY_MISMATCH: 403,
  COMMITTED_PARAMS_MISMATCH: 409,
  MCP_SESSION_MISMATCH: 403,
  SETTLEMENT_IN_PROGRESS: 409,
  NOT_AUTHORIZED: 403,
};

/**
 * Solidity custom error name (RightsRegistry / RightsNFT) -> ErrorCode.
 * Used by the gateway to map revert reasons and by the stability test.
 */
export const SOLIDITY_ERROR_TO_CODE: Readonly<Record<string, ErrorCode>> = {
  UnderPayment: ErrorCode.UNDERPAYMENT,
  ReceiptAlreadyIssued: ErrorCode.PAYMENT_ID_PAYLOAD_CONFLICT,
  ReceiptAlreadyConsumed: ErrorCode.RECEIPT_ALREADY_CONSUMED,
  ReceiptExpired: ErrorCode.RECEIPT_EXPIRED,
  UseLimitExceeded: ErrorCode.USE_LIMIT_EXCEEDED,
  LicenseEpochMismatch: ErrorCode.LICENSE_EPOCH_MISMATCH,
  LicenseInvalidatedOnTransfer: ErrorCode.LICENSE_INVALIDATED_ON_TRANSFER,
  ResourceHashMismatch: ErrorCode.RESOURCE_HASH_MISMATCH,
  PolicyHashMismatch: ErrorCode.POLICY_HASH_MISMATCH,
  PolicyContentMismatch: ErrorCode.POLICY_CONTENT_MISMATCH,
  ExpiryMismatch: ErrorCode.EXPIRY_MISMATCH,
  ContractWalletUnsupported: ErrorCode.CONTRACT_WALLET_UNSUPPORTED,
  NotAuthorized: ErrorCode.NOT_AUTHORIZED,
  CommittedParamsMismatch: ErrorCode.COMMITTED_PARAMS_MISMATCH,
};

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && Object.hasOwn(ErrorCode, value);
}
