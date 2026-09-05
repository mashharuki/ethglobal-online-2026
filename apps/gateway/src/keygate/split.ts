import { blindShareU, buildDomain, keyGateTypedData } from "@truenft/shared";
import { and, eq } from "drizzle-orm";
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
 */
export type BlindedShareRow = {
  blindedU: Hex;
  accessEpochAtGrant: bigint | null;
  createdNow: boolean;
};

async function findBlindedShare(
  db: Db,
  key: { assetId: Hex; wallet: Address; path: BlindedSharePath },
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
  env: Pick<Env, "HEDERA_CHAIN_ID" | "RIGHTS_REGISTRY_ADDRESS">,
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
  const existing = await findBlindedShare(db, input);
  if (existing !== undefined) return existing;
  if (input.keyGateSig === undefined) {
    throw new AppError(
      "SIGNATURE_INVALID",
      "keyGateSig is required on first access (no blinded share stored yet)",
    );
  }
  const receiptHash = input.receiptHash ?? `0x${"00".repeat(32)}`;
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
    .onConflictDoNothing();
  // a concurrent first access may have won the insert; the stored row is authoritative
  const stored = await findBlindedShare(db, input);
  if (stored === undefined) throw new Error("blinded share insert vanished");
  return { ...stored, createdNow: stored.blindedU === blindedU };
}
