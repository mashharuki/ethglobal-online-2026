import {
  type RightsReceipt,
  receiptTypedData,
  type TrueCollectiveDomain,
} from "@truenft/shared";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { walletBlindedShares } from "../db/schema";
import type { Db } from "../db/types";
import type { Env } from "../env";
import { readReceiptSignerKey } from "../keygate/vault";

/**
 * Rights Receipt issuance helpers (tasks.md T082). After settleAndIssue is confirmed the
 * gateway server-signs the EIP-712 receipt (a convenience credential - the on-chain
 * `hasValidConsumption` stays the authority, docs/idea.md 9.1) and stores the licensee's
 * blinded share so later /keygate/share calls need only the nonce-bound auth signature.
 */
export function receiptSignerAddress(env: Env): Address {
  return privateKeyToAccount(readReceiptSignerKey(env)).address;
}

export async function signReceipt(
  env: Env,
  domain: TrueCollectiveDomain,
  receipt: RightsReceipt,
): Promise<Hex> {
  const signer = privateKeyToAccount(readReceiptSignerKey(env));
  return signer.signTypedData(receiptTypedData(domain, receipt));
}

/** Idempotent: a second issuance for the same (asset, licensee) keeps the first blinded share. */
export async function storeLicenseeBlindedShare(
  db: Db,
  input: { assetId: Hex; licensee: Address; receiptHash: Hex; blindedU: Hex },
): Promise<void> {
  await db
    .insert(walletBlindedShares)
    .values({
      assetId: input.assetId,
      wallet: input.licensee,
      path: "licensee",
      blindedU: input.blindedU,
      receiptHash: input.receiptHash,
    })
    .onConflictDoNothing();
}
