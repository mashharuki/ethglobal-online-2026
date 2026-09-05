import {
  buildDomain,
  ownerAuthTypedData,
  REVOCATION_ACTION_BUMP_LICENSE_EPOCH,
  revocationTypedData,
} from "@truenft/shared";
import type { Hono } from "hono";
import { z } from "zod";
import { issueNonce, toUnixSeconds } from "../auth/nonce";
import { releaseToOwner } from "../keygate/release";
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
 * Owner path (tasks.md T087, gateway-api.md "所有者パス"): challenge issuance and the
 * share_G release. The release decision itself lives in keygate/release.ts.
 */
const ChallengeBody = z.object({
  assetId: hex32,
  wallet: address,
  purpose: z
    .enum(["owner-access", "bump-license-epoch"])
    .default("owner-access"),
});

const KeygateBody = z.object({
  assetId: hex32,
  wallet: address,
  authSig: signature,
  keyGateSig: signature.optional(),
  ownerSession: z.string().max(4096).optional(),
});

export function registerOwnerRoutes(app: Hono<AppEnv>): void {
  app.post("/owner/challenge", async (c) => {
    const services = c.get("services");
    const body = await parseBody(c, ChallengeBody);
    let tokenId: bigint;
    try {
      tokenId = (await services.resolveAsset(body.assetId)).tokenId;
    } catch (error) {
      if (error instanceof AssetNotFoundError) throw notFound("unknown asset");
      throw error;
    }
    const chainId = services.release.deployment.chainId;
    const issued = await issueNonce(services.db, {
      wallet: body.wallet,
      purpose: "owner-access",
      chainId,
      now: services.now(),
    });
    const domain = buildDomain(
      services.release.deployment.rightsRegistry,
      chainId,
    );
    const expiresAt = toUnixSeconds(issued.expiresAt);
    const typedData =
      body.purpose === "bump-license-epoch"
        ? revocationTypedData(domain, {
            nonce: issued.nonce,
            chainId: BigInt(chainId),
            tokenId,
            assetId: body.assetId,
            action: REVOCATION_ACTION_BUMP_LICENSE_EPOCH,
            expiresAt,
          })
        : ownerAuthTypedData(domain, {
            nonce: issued.nonce,
            chainId: BigInt(chainId),
            tokenId,
            assetId: body.assetId,
            expiresAt,
          });
    return c.json({
      typedData: jsonSafe(typedData),
      nonce: issued.nonce,
      expiresAt: Number(expiresAt),
    });
  });

  app.post("/owner/keygate", async (c) => {
    const services = c.get("services");
    const body = await parseBody(c, KeygateBody);
    try {
      return c.json(await releaseToOwner(services.release, body));
    } catch (error) {
      if (error instanceof AssetNotFoundError) throw notFound("unknown asset");
      throw error;
    }
  });
}
