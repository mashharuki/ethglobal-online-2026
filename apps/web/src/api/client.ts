import type { components, paths } from "@truenft/openapi";
import createClient from "openapi-fetch";

/**
 * Typed Access Gateway client (tasks.md T105, FR-029): every web -> gateway call goes through
 * here, typed with the openapi-generated `paths`, so an API drift is a `tsc` error. Domain
 * rejections surface as `GatewayError` carrying the openapi ErrorCode.
 */
type Schemas = components["schemas"];
export type AssetSummary = Schemas["AssetSummary"];
export type ChallengeResponse = Schemas["ChallengeResponse"];
export type OwnerKeygateResponse = Schemas["OwnerKeygateResponse"];
export type KeygateShareOwnerResponse = Schemas["KeygateShareOwnerResponse"];
export type KeygateShareLicenseeResponse =
  Schemas["KeygateShareLicenseeResponse"];
export type PaymentRequired = Schemas["PaymentRequired"];
export type PaymentAccept = Schemas["PaymentAccept"];
export type SettleResponse = Schemas["SettleResponse"];
export type AuditEntry = Schemas["AuditEntry"];

export class GatewayError extends Error {
  override readonly name = "GatewayError";
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Maps a non-2xx body to GatewayError: openapi `Error` {code} or the `{error}` envelope. */
export function toGatewayError(status: number, body: unknown): GatewayError {
  const record =
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>)
      : {};
  const code =
    typeof record.code === "string"
      ? record.code
      : typeof record.error === "string"
        ? record.error
        : `HTTP_${status}`;
  const message =
    typeof record.message === "string"
      ? record.message
      : `gateway answered ${status}`;
  return new GatewayError(status, code, message);
}

export type Api = ReturnType<typeof createClient<paths>>;

export function createApi(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Api {
  return createClient<paths>({ baseUrl, fetch: fetchImpl });
}

function unwrap<T>(result: {
  data?: T;
  error?: unknown;
  response: Response;
}): T {
  if (result.error !== undefined || result.data === undefined) {
    throw toGatewayError(result.response.status, result.error);
  }
  return result.data;
}

export async function listAssets(api: Api): Promise<AssetSummary[]> {
  return unwrap(await api.GET("/assets"));
}

export async function ownerChallenge(
  api: Api,
  body: Schemas["OwnerChallengeRequest"],
): Promise<ChallengeResponse> {
  return unwrap(await api.POST("/owner/challenge", { body }));
}

export async function ownerKeygate(
  api: Api,
  body: Schemas["OwnerKeygateRequest"],
): Promise<OwnerKeygateResponse> {
  return unwrap(await api.POST("/owner/keygate", { body }));
}

export async function licenseeChallenge(
  api: Api,
  body: Schemas["LicenseeChallengeRequest"],
): Promise<ChallengeResponse> {
  return unwrap(await api.POST("/keygate/challenge", { body }));
}

export async function keygateShare(
  api: Api,
  body: Schemas["KeygateShareRequest"],
): Promise<KeygateShareOwnerResponse | KeygateShareLicenseeResponse> {
  return unwrap(await api.POST("/keygate/share", { body }));
}

/** GET /assets/{assetId}/paid answers 402 with the quote: that body is the value here. */
export async function paymentRequirements(
  api: Api,
  assetId: `0x${string}`,
): Promise<PaymentRequired> {
  const result = await api.GET("/assets/{assetId}/paid", {
    params: { path: { assetId } },
  });
  const body = result.error as Partial<PaymentRequired> | undefined;
  if (result.response.status === 402 && Array.isArray(body?.accepts)) {
    return body as PaymentRequired;
  }
  // a 402 without `accepts` is a domain rejection (e.g. UNDERPAYMENT), not a quote
  throw toGatewayError(result.response.status, result.error);
}

export async function settlePayment(
  api: Api,
  assetId: `0x${string}`,
  xPayment: string,
  licensee: `0x${string}`,
): Promise<SettleResponse> {
  return unwrap(
    await api.POST("/assets/{assetId}/paid", {
      params: { path: { assetId } },
      headers: { "X-PAYMENT": xPayment },
      body: { licensee },
    }),
  );
}

export async function listAudit(
  api: Api,
  query: { assetId?: `0x${string}`; since?: number; limit?: number } = {},
): Promise<AuditEntry[]> {
  return unwrap(await api.GET("/audit", { params: { query } }));
}

export async function graphQuery<T>(
  api: Api,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const result = unwrap(
    await api.POST("/graph", { body: { query, variables } }),
  ) as { data?: T; errors?: Array<{ message: string }> };
  if (result.errors !== undefined && result.errors.length > 0) {
    throw new GatewayError(
      200,
      "GRAPH_ERROR",
      result.errors.map((e) => e.message).join("; "),
    );
  }
  if (result.data === undefined) {
    throw new GatewayError(200, "GRAPH_ERROR", "subgraph returned no data");
  }
  return result.data;
}
