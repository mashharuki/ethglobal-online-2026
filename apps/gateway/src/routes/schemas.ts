import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Db } from "../db/types";
import type { Env } from "../env";
import type { Services } from "../services";

/**
 * Shared request-validation helpers for the routes (security.md: validate every external
 * input at the boundary with zod). Malformed input answers 400 with the `{ error }` envelope
 * used for non-domain failures (404 / 500 use the same shape); domain rejections are the
 * openapi Error body produced by AppError.
 */
export type AppEnv = {
  Bindings: Env;
  Variables: { db: Db; services: Services };
};

export const hex32 = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "expected 0x-prefixed 32-byte hex")
  .transform((v) => v as `0x${string}`);
export const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "expected 0x-prefixed address")
  .transform((v) => v as `0x${string}`);
export const signature = z
  .string()
  .regex(/^0x[0-9a-fA-F]{130}$/, "expected a 65-byte signature")
  .transform((v) => v as `0x${string}`);
export const uintString = z.string().regex(/^\d+$/, "expected a decimal uint");

export function badRequest(message: string, issues?: unknown): HTTPException {
  return new HTTPException(400, {
    res: Response.json(
      { error: "bad_request", message, issues },
      { status: 400 },
    ),
  });
}

export function notFound(message: string): HTTPException {
  return new HTTPException(404, {
    res: Response.json({ error: "not_found", message }, { status: 404 }),
  });
}

export async function parseBody<T extends z.ZodTypeAny>(
  c: Context,
  schema: T,
): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw badRequest("body must be JSON");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw badRequest(
      "invalid request body",
      parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    );
  }
  return parsed.data;
}

export function parseAssetId(c: Context): `0x${string}` {
  const parsed = hex32.safeParse(c.req.param("assetId"));
  if (!parsed.success) throw badRequest("assetId must be 32-byte hex");
  return parsed.data;
}

/** bigint -> decimal string so EIP-712 messages / receipts survive JSON. */
export function jsonSafe<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
  ) as T;
}
