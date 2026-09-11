import type { JsonResponse } from "@truenft/openapi";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { PinataSDK } from "pinata";
import { z } from "zod";
import { AppError } from "../errors";
import { extractBearerToken } from "../mcp/auth";
import { verifyPrincipalAccessToken } from "../mcp/privyClient";
import { clientIp, rateLimit, SlidingWindow } from "../middleware/rateLimit";
import type { AppEnv } from "./schemas";

type VerifyPrincipal = typeof verifyPrincipalAccessToken;

const limits = {
  preview: {
    size: 10 * 1024 * 1024,
    types: ["image/png", "image/jpeg", "image/webp", "application/json"],
  },
  "encrypted-content": {
    size: 25 * 1024 * 1024,
    types: ["application/octet-stream"],
  },
  manifest: { size: 256 * 1024, types: ["application/json"] },
};
const uploadRequest = z
  .object({
    purpose: z.enum(["preview", "encrypted-content", "manifest"]),
    size: z.number().int().positive(),
    mimeType: z.string(),
  })
  .strict()
  .refine(
    (v) =>
      v.size <= limits[v.purpose].size &&
      limits[v.purpose].types.includes(v.mimeType),
  );

export function registerCreatorUploadRoutes(
  app: Hono<AppEnv>,
  verifyPrincipal: VerifyPrincipal = verifyPrincipalAccessToken,
): void {
  const principals = new SlidingWindow(12, 60_000);
  app.use("/creator/uploads", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.use(
    "/creator/uploads",
    rateLimit({ limit: 30, windowMs: 60_000, key: clientIp }),
  );
  app.use(
    "/creator/uploads",
    bodyLimit({
      maxSize: 2048,
      onError: (c) => c.json({ error: "upload_request_too_large" }, 413),
    }),
  );
  app.post("/creator/uploads", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (token === undefined) throw new AppError("AUTH_TOKEN_INVALID");
    const principal = await verifyPrincipal(c.env, token).catch(() => {
      throw new AppError("AUTH_TOKEN_INVALID");
    });
    const retryAfter = principals.hit(principal.principalId, Date.now());
    if (retryAfter > 0) {
      c.header("Retry-After", String(retryAfter));
      throw new AppError("RATE_LIMITED");
    }
    const parsed = uploadRequest.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success)
      return c.json(
        {
          error: "invalid_upload_request",
          message: "Invalid upload purpose, MIME type, or size",
        },
        400,
      );
    if (!c.env.PINATA_JWT)
      return c.json(
        {
          error: "uploads_not_configured",
          message: "Pinata uploads are not configured; use manual IPFS upload",
        },
        503,
      );
    const { purpose, size, mimeType } = parsed.data;
    try {
      const signedUrl = await new PinataSDK({
        pinataJwt: c.env.PINATA_JWT,
      }).upload.public.createSignedURL({
        expires: 60,
        name: `truecollective-${purpose}`,
        mimeTypes: [mimeType],
        maxFileSize: size,
        keyvalues: { app: "truecollective", purpose },
      });
      const body: JsonResponse<"/creator/uploads", "post"> = {
        signedUrl,
        expiresIn: 60,
      };
      return c.json(body);
    } catch {
      return c.json(
        {
          error: "upload_authorization_failed",
          message: "Pinata upload authorization failed; retry later",
        },
        502,
      );
    }
  });
}
