import {
  buildDomain,
  REVOCATION_ACTION_BUMP_LICENSE_EPOCH,
  revocationTypedData,
} from "@truenft/shared";
import type { Hono } from "hono";
import { type Address, isAddressEqual, recoverTypedDataAddress } from "viem";
import { z } from "zod";
import { denyOutcome, writeAudit } from "../audit/log";
import { toUnixSeconds } from "../auth/nonce";
import { AppError } from "../errors";
import { matchChallenge } from "../keygate/release";
import { AssetNotFoundError } from "../manifest/resolver";
import {
  type AppEnv,
  address,
  notFound,
  parseAssetId,
  parseBody,
  signature,
} from "./schemas";

/**
 * Creator-signed emergency revocation (tasks.md T091): License Epoch +1 through the
 * operator queue. Only a RevocationChallenge signature (action = "bump-license-epoch")
 * is accepted - an OwnerAuthChallenge signature over the same nonce recovers to a
 * different address and is refused (SIGNATURE_INVALID). The creator is read on chain.
 */
const Body = z.object({ wallet: address, revocationSig: signature });

export function registerAdminRoutes(app: Hono<AppEnv>): void {
  app.post("/assets/:assetId/bump-license-epoch", async (c) => {
    const services = c.get("services");
    const assetId = parseAssetId(c);
    const body = await parseBody(c, Body);
    let asset: Awaited<ReturnType<typeof services.resolveAsset>>;
    try {
      asset = await services.resolveAsset(assetId);
    } catch (error) {
      if (error instanceof AssetNotFoundError) throw notFound("unknown asset");
      throw error;
    }
    const subject = {
      assetId,
      tokenId: asset.tokenId.toString(),
      wallet: body.wallet,
    };
    try {
      const creator = await services.creatorOf(asset.tokenId);
      if (!isAddressEqual(creator, body.wallet)) {
        throw new AppError("NOT_AUTHORIZED", "only the creator may revoke");
      }
      const chainId = services.release.deployment.chainId;
      const domain = buildDomain(
        services.release.deployment.rightsRegistry,
        chainId,
      );
      const nonce = await matchChallenge(
        services.release,
        body.wallet,
        "owner-access",
        async (row) => {
          if (row.expiresAt.getTime() <= services.now().getTime()) {
            throw new AppError("NONCE_INVALID_OR_EXPIRED");
          }
          let recovered: Address | undefined;
          try {
            recovered = await recoverTypedDataAddress({
              ...revocationTypedData(domain, {
                nonce: row.nonce,
                chainId: BigInt(row.chainId),
                tokenId: asset.tokenId,
                assetId,
                action: REVOCATION_ACTION_BUMP_LICENSE_EPOCH,
                expiresAt: toUnixSeconds(row.expiresAt),
              }),
              signature: body.revocationSig,
            });
          } catch {
            recovered = undefined;
          }
          if (
            recovered === undefined ||
            !isAddressEqual(recovered, body.wallet)
          ) {
            throw new AppError("SIGNATURE_INVALID");
          }
          return row.nonce;
        },
      );
      const fromEpoch = await services.licenseEpoch(asset.tokenId);
      const onchainTx = await services.bumpLicenseEpoch({
        tokenId: asset.tokenId,
        fromEpoch,
        idempotencyKey: `bump:${asset.tokenId}:${nonce}`,
      });
      await services.waitForTx(onchainTx);
      const newEpoch = fromEpoch + 1n;
      await writeAudit(services.db, {
        actor: body.wallet,
        action: "policy_update",
        subject: {
          ...subject,
          fromEpoch: fromEpoch.toString(),
          newEpoch: newEpoch.toString(),
        },
        outcome: "allow",
        onchainRef: onchainTx,
      });
      return c.json({
        tokenId: asset.tokenId.toString(),
        newEpoch: Number(newEpoch),
        onchainTx,
      });
    } catch (error) {
      if (error instanceof AppError) {
        await writeAudit(services.db, {
          actor: body.wallet,
          action: "deny",
          subject: { ...subject, attempted: "policy_update" },
          outcome: denyOutcome(error.code),
        });
      }
      throw error;
    }
  });
}
