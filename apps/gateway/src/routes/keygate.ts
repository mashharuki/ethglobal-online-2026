import { buildDomain, licenseeAuthTypedData } from "@truenft/shared";
import type { Hono } from "hono";
import { z } from "zod";
import { issueNonce, toUnixSeconds } from "../auth/nonce";
import { releaseToLicensee, releaseToOwner } from "../keygate/release";
import { AssetNotFoundError } from "../manifest/resolver";
import {
  type AppEnv,
  address,
  hex32,
  jsonSafe,
  notFound,
  parseBody,
  signature,
} from "./schemas";

/**
 * KeyGate routes (tasks.md T089): licensee challenge issuance and the discriminated
 * /keygate/share. The licensee path consumes through the ReceiptLock Durable Object
 * (release ports); the owner path is /owner/keygate under another name.
 */
const LicenseeChallengeBody = z.object({
  receiptHash: hex32,
  wallet: address,
});

const ShareBody = z.discriminatedUnion("path", [
  z.object({
    path: z.literal("owner"),
    assetId: hex32,
    wallet: address,
    authSig: signature,
    keyGateSig: signature.optional(),
    ownerSession: z.string().max(4096).optional(),
  }),
  z.object({
    path: z.literal("licensee"),
    assetId: hex32,
    receiptHash: hex32,
    authSig: signature,
    keyGateSig: signature.optional(),
    retryUseIndex: z.number().int().min(0).optional(),
  }),
]);

export function registerKeygateRoutes(app: Hono<AppEnv>): void {
  app.post("/keygate/challenge", async (c) => {
    const services = c.get("services");
    const body = await parseBody(c, LicenseeChallengeBody);
    const chainId = services.release.deployment.chainId;
    const issued = await issueNonce(services.db, {
      wallet: body.wallet,
      purpose: "keygate-challenge",
      chainId,
      now: services.now(),
    });
    const expiresAt = toUnixSeconds(issued.expiresAt);
    const typedData = licenseeAuthTypedData(
      buildDomain(services.release.deployment.rightsRegistry, chainId),
      {
        nonce: issued.nonce,
        chainId: BigInt(chainId),
        receiptHash: body.receiptHash,
        expiresAt,
      },
    );
    return c.json({
      typedData: jsonSafe(typedData),
      nonce: issued.nonce,
      expiresAt: Number(expiresAt),
    });
  });

  app.post("/keygate/share", async (c) => {
    const services = c.get("services");
    const body = await parseBody(c, ShareBody);
    try {
      if (body.path === "owner") {
        const released = await releaseToOwner(services.release, body);
        return c.json({ path: "owner", ...released });
      }
      const released = await releaseToLicensee(services.release, body);
      return c.json({ path: "licensee", ...released });
    } catch (error) {
      if (error instanceof AssetNotFoundError) throw notFound("unknown asset");
      throw error;
    }
  });
}
