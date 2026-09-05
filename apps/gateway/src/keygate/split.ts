import { blindShareU, buildDomain, keyGateTypedData } from "@truenft/shared";
import { and, eq, sql } from "drizzle-orm";
import {
  type Address,
  bytesToHex,
  type Hex,
  isAddressEqual,
  recoverTypedDataAddress,
} from "viem";
import { type BlindedSharePath, walletBlindedShares } from "../db/schema";
import type { Db } from "../db/types";
import type { Env } from "../env";
import { AppError } from "../errors";
import { readShareU, wipe } from "./vault";

/**
 * Server-side blinding (tasks.md T077, R-1 / R-1a): blindedU = share_U XOR HKDF(keyGateSig).
 * share_U is read from the secrets store, used for one XOR and wiped. The blinded value is
 * computed ONCE per (asset, wallet, path) and reused from wallet_blinded_shares afterwards, so
 * the KeyGateChallenge signature only ever travels on first access.
 *
 * Licensee binding: the licensee KeyGateChallenge includes the receiptHash, so the stored
 * share is only reusable for the SAME receipt. A second receipt for the same asset + wallet
 * is a new first access (keyGateSig required) and replaces the stored row.
 */
export type BlindedShareRow = {
  blindedU: Hex;
  accessEpochAtGrant: bigint | null;
  createdNow: boolean;
};

const ZERO32 = `0x${"00".repeat(32)}` as Hex;

async function findBlindedShare(
  db: Db,
  key: { assetId: Hex; wallet: Address; path: BlindedSharePath },
  receiptHash: Hex,
): Promise<BlindedShareRow | undefined> {
  const [row] = await db
    .select()
    .from(walletBlindedShares)
    .where(
      and(
        eq(walletBlindedShares.assetId, key.assetId),
        eq(walletBlindedShares.wallet, key.wallet),
        eq(walletBlindedShares.path, key.path),
      ),
    )
    .limit(1);
  if (row === undefined) return undefined;
  if (
    key.path === "licensee" &&
    (row.receiptHash ?? ZERO32).toLowerCase() !== receiptHash.toLowerCase()
  ) {
    return undefined; // bound to another receipt: treat as absent
  }
  return {
    blindedU: row.blindedU,
    accessEpochAtGrant: row.accessEpochAtGrant,
    createdNow: false,
  };
}

/**
 * The KeyGateChallenge signature is key material, not authentication (R-1a) - but it must be
 * the wallet's own signature, otherwise the stored blindedU could never be unblinded by that
 * wallet. This check only protects the wallet from a garbage first-access request.
 */
async function assertKeyGateSigBelongsTo(
  env: Pick<Env, "HEDERA_CHAIN_ID">,
  registry: Address,
  input: {
    assetId: Hex;
    wallet: Address;
    path: BlindedSharePath;
    receiptHash: Hex;
    keyGateSig: Hex;
  },
): Promise<void> {
  const domain = buildDomain(registry, Number(env.HEDERA_CHAIN_ID));
  let recovered: Address | undefined;
  try {
    recovered = await recoverTypedDataAddress({
      ...keyGateTypedData(domain, {
        assetId: input.assetId,
        purpose: input.path,
        receiptHash: input.receiptHash,
      }),
      signature: input.keyGateSig,
    });
  } catch {
    recovered = undefined;
  }
  if (recovered === undefined || !isAddressEqual(recovered, input.wallet)) {
    throw new AppError(
      "SIGNATURE_INVALID",
      "keyGateSig is not this wallet's KeyGateChallenge signature",
    );
  }
}

export type GetOrCreateInput = {
  assetId: Hex;
  wallet: Address;
  path: BlindedSharePath;
  /** required on first access only */
  keyGateSig?: Hex;
  /** owner path: epoch at grant (audit / UX) */
  accessEpochAtGrant?: bigint;
  /** licensee path: the receipt the share is bound to */
  receiptHash?: Hex;
};

export async function getOrCreateBlindedShare(
  db: Db,
  env: Env,
  registry: Address,
  input: GetOrCreateInput,
): Promise<BlindedShareRow> {
  const receiptHash = input.receiptHash ?? ZERO32;
  const existing = await findBlindedShare(db, input, receiptHash);
  if (existing !== undefined) return existing;
  if (input.keyGateSig === undefined) {
    throw new AppError(
      "SIGNATURE_INVALID",
      "keyGateSig is required on first access (no blinded share stored for this receipt yet)",
    );
  }
  await assertKeyGateSigBelongsTo(env, registry, {
    assetId: input.assetId,
    wallet: input.wallet,
    path: input.path,
    receiptHash,
    keyGateSig: input.keyGateSig,
  });
  const shareU = readShareU(env, input.assetId);
  let blinded: Uint8Array;
  try {
    blinded = await blindShareU(shareU, input.keyGateSig, input.assetId);
  } finally {
    wipe(shareU);
  }
  const blindedU = bytesToHex(blinded);
  blinded.fill(0);
  await db
    .insert(walletBlindedShares)
    .values({
      assetId: input.assetId,
      wallet: input.wallet,
      path: input.path,
      blindedU,
      accessEpochAtGrant: input.accessEpochAtGrant,
      receiptHash: input.receiptHash,
    })
    .onConflictDoUpdate({
      target: [
        walletBlindedShares.assetId,
        walletBlindedShares.wallet,
        walletBlindedShares.path,
      ],
      set: {
        blindedU,
        accessEpochAtGrant: input.accessEpochAtGrant,
        receiptHash: input.receiptHash,
      },
      // only a licensee row bound to ANOTHER receipt is replaced; a concurrent first access
      // for the same (asset, wallet, path, receipt) keeps the first writer's row so both
      // callers read back one canonical blindedU (KeyGateChallenge signatures are
      // deterministic - RFC6979 - so both writers derived the same value anyway)
      setWhere: sql`${walletBlindedShares.path} = 'licensee' AND ${walletBlindedShares.receiptHash} IS DISTINCT FROM excluded.receipt_hash`,
    });
  const stored = await findBlindedShare(db, input, receiptHash);
  if (stored === undefined) throw new Error("blinded share upsert vanished");
  return { ...stored, createdNow: stored.blindedU === blindedU };
}
