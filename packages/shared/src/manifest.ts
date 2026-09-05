import type { Address, Hex } from "viem";
import { z } from "zod";
import {
  computePolicyHash,
  isUint256Decimal,
  type PolicyHashInput,
  permissionsToBitflags,
  TransferMode,
  WEIBAR_PER_TINYBAR,
  weibarToTinybar,
} from "./hashing";

/**
 * Rights Manifest (contracts/rights-manifest.schema.json, data-model.md §2.1).
 * The zod schema is 1:1 with the JSON Schema; refinements enforce the rules the
 * JSON Schema cannot express (bps sum, tinybar precision).
 */

const hex32 = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "expected 0x-prefixed 32-byte hex");
const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "expected 0x-prefixed address");
const uint32Max = 4_294_967_295;

export const RightsManifestSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    assetId: hex32,
    nftContract: address,
    tokenId: z
      .string()
      .refine(isUint256Decimal, "tokenId must be a decimal uint256 string"),
    previewURI: z.string().url(),
    encryptedContentURI: z.string().url(),
    contentHash: hex32,
    keyGate: z
      .object({
        scheme: z.literal("xor-2share"),
        keyGateVersion: z.literal(1),
        conditionsHash: hex32,
        ownerCondition: z.string().min(1),
        licenseCondition: z.string().min(1),
      })
      .strict(),
    ownerAccess: z
      .object({
        price: z.literal("0"),
        durationSec: z.number().int().min(1),
      })
      .strict(),
    paidAccess: z
      .object({
        price: z
          .string()
          .refine(
            (value) => /^[1-9][0-9]*$/.test(value) && isUint256Decimal(value),
            "price must be a positive weibar integer string within uint256",
          )
          .refine(
            (value) =>
              isUint256Decimal(value) &&
              BigInt(value) % WEIBAR_PER_TINYBAR === 0n,
            {
              message:
                "price must be a multiple of 1e10 weibar (tinybar precision)",
            },
          ),
        durationSec: z.number().int().min(1),
        maxUses: z.number().int().min(1).max(uint32Max),
      })
      .strict(),
    permissions: z
      .object({
        commercialUse: z.boolean(),
        aiTraining: z.boolean(),
        derivativeGeneration: z.boolean(),
      })
      .strict(),
    transferMode: z.enum(["SURVIVE_TRANSFER", "INVALIDATE_ON_TRANSFER"]),
    revenueSplit: z
      .object({
        creatorBps: z.number().int().min(0).max(10_000),
        ownerBps: z.number().int().min(0).max(10_000),
      })
      .strict()
      .refine((split) => split.creatorBps + split.ownerBps === 10_000, {
        message: "creatorBps + ownerBps must equal 10000",
      }),
  })
  .strict();

export type RightsManifest = z.infer<typeof RightsManifestSchema>;

export type ManifestParseResult =
  | { ok: true; data: RightsManifest }
  | { ok: false; error: z.ZodError<RightsManifest> };

/** Result-pattern wrapper; the gateway maps `ok: false` to MANIFEST_SCHEMA_INVALID. */
export function parseManifest(input: unknown): ManifestParseResult {
  const result = RightsManifestSchema.safeParse(input);
  return result.success
    ? { ok: true, data: result.data }
    : { ok: false, error: result.error };
}

/** PolicyHash input derived from a manifest (price converted weibar -> tinybar, R-4/R-6a). */
export function manifestToPolicyInput(
  manifest: RightsManifest,
): PolicyHashInput {
  return {
    priceTinybar: weibarToTinybar(BigInt(manifest.paidAccess.price)),
    durationSec: BigInt(manifest.paidAccess.durationSec),
    maxUses: manifest.paidAccess.maxUses,
    permittedAction: permissionsToBitflags(manifest.permissions),
    transferMode: TransferMode[manifest.transferMode],
    creatorBps: manifest.revenueSplit.creatorBps,
    ownerBps: manifest.revenueSplit.ownerBps,
  };
}

export function manifestPolicyHash(manifest: RightsManifest): Hex {
  return computePolicyHash(manifestToPolicyInput(manifest));
}

export const KEYGATE_HKDF_INFO_PREFIX = "truenft/keygate/v1/";

/**
 * HKDF `info` for deriving share_U' from the KeyGateChallenge signature
 * (eip712-types.md): utf8("truenft/keygate/v1/" + assetIdHex).
 */
export function deriveShareUInfo(assetId: Hex): string {
  return `${KEYGATE_HKDF_INFO_PREFIX}${assetId.toLowerCase()}`;
}

export function manifestAddresses(manifest: RightsManifest): {
  nftContract: Address;
  tokenId: bigint;
} {
  return {
    nftContract: manifest.nftContract as Address,
    tokenId: BigInt(manifest.tokenId),
  };
}
