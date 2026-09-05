import {
  type LicenseeAuthChallenge,
  licenseeAuthTypedData,
  type OwnerAuthChallenge,
  ownerAuthTypedData,
  type TrueCollectiveDomain,
} from "@truenft/shared";
import {
  type Address,
  type Hex,
  isAddressEqual,
  recoverTypedDataAddress,
} from "viem";
import { AppError } from "../errors";

/**
 * EIP-712 authentication (tasks.md T078, FR-024, R-1a). Only the nonce-bound
 * OwnerAuthChallenge / LicenseeAuthChallenge are accepted here; a KeyGateChallenge signature
 * is key-derivation material and is deliberately NOT verifiable through this module.
 *
 * chainId handling: the challenge the client signed is reconstructed server-side from the
 * nonce row, so a signature produced under another domain simply fails to recover
 * (SIGNATURE_INVALID). CHAIN_ID_MISMATCH is raised when the challenge itself was issued for
 * a chain other than the gateway's.
 */
export type AuthContext = {
  domain: TrueCollectiveDomain;
  /** unix seconds */
  nowSec: bigint;
};

function assertChallengeFresh(
  ctx: AuthContext,
  challenge: { chainId: bigint; expiresAt: bigint },
): void {
  if (challenge.chainId !== BigInt(ctx.domain.chainId)) {
    throw new AppError("CHAIN_ID_MISMATCH", undefined, {
      expected: ctx.domain.chainId,
      actual: challenge.chainId.toString(),
    });
  }
  if (challenge.expiresAt <= ctx.nowSec) {
    throw new AppError("NONCE_INVALID_OR_EXPIRED", "challenge expired");
  }
}

async function recover(
  typedData: Parameters<typeof recoverTypedDataAddress>[0],
): Promise<Address | undefined> {
  try {
    return await recoverTypedDataAddress(typedData);
  } catch {
    return undefined;
  }
}

/** Returns the wallet when `signature` is its signature over `challenge`; throws otherwise. */
export async function verifyOwnerAuth(
  ctx: AuthContext,
  challenge: OwnerAuthChallenge,
  signature: Hex,
  expectedWallet: Address,
): Promise<Address> {
  assertChallengeFresh(ctx, challenge);
  const recovered = await recover({
    ...ownerAuthTypedData(ctx.domain, challenge),
    signature,
  });
  if (recovered === undefined || !isAddressEqual(recovered, expectedWallet)) {
    throw new AppError("SIGNATURE_INVALID");
  }
  return recovered;
}

/** Returns the recovered signer; the caller compares it with `receipt.licensee` (LICENSEE_MISMATCH). */
export async function recoverLicenseeAuth(
  ctx: AuthContext,
  challenge: LicenseeAuthChallenge,
  signature: Hex,
): Promise<Address> {
  assertChallengeFresh(ctx, challenge);
  const recovered = await recover({
    ...licenseeAuthTypedData(ctx.domain, challenge),
    signature,
  });
  if (recovered === undefined) throw new AppError("SIGNATURE_INVALID");
  return recovered;
}

/** FR-025: EOA only. `getCode` is the chain read (eth_getCode). */
export async function assertEoa(
  getCode: (address: Address) => Promise<Hex | undefined>,
  wallet: Address,
): Promise<void> {
  const code = await getCode(wallet);
  if (code !== undefined && code !== "0x") {
    throw new AppError("CONTRACT_WALLET_UNSUPPORTED");
  }
}
