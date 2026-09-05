import { AppError } from "../errors";

/**
 * Shared response helpers for the Durable Objects: the `{ ok, error }` envelope that
 * do/client.ts re-raises as AppError on the Hono side. Internal failures log the error
 * class only (never the message) and answer a generic 500.
 */
export function doFailure(
  code: string,
  message: string,
  status: number,
): Response {
  return Response.json({ ok: false, error: { code, message } }, { status });
}

export function doErrorResponse(error: unknown, label: string): Response {
  if (error instanceof AppError) {
    return Response.json(
      { ok: false, error: error.toBody() },
      { status: error.status },
    );
  }
  console.error(`${label} failure`, {
    name: error instanceof Error ? error.name : "unknown",
  });
  return doFailure("INTERNAL", `${label} failure`, 500);
}
