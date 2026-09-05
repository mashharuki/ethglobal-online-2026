import {
  buildDomain,
  keyGateTypedData,
  licenseeAuthTypedData,
  ownerAuthTypedData,
} from "@truenft/shared";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  assertEoa,
  recoverLicenseeAuth,
  verifyOwnerAuth,
} from "../src/auth/verify";
import { AppError } from "../src/errors";

/** EIP-712 verification in workerd (T078): signatures are real secp256k1, nothing is faked. */
const REGISTRY = "0x2222222222222222222222222222222222222222";
const wallet = privateKeyToAccount(`0x${"a1".repeat(32)}`);
const other = privateKeyToAccount(`0x${"b2".repeat(32)}`);
const domain = buildDomain(REGISTRY, 296);
const ctx = { domain, nowSec: 1_800_000_000n };
const ASSET = `0x${"a5".repeat(32)}` as Hex;
const NONCE = `0x${"55".repeat(32)}` as Hex;

const ownerChallenge = {
  nonce: NONCE,
  chainId: 296n,
  tokenId: 1n,
  assetId: ASSET,
  expiresAt: 1_800_000_100n,
};

async function code(run: Promise<unknown>): Promise<string | undefined> {
  try {
    await run;
    return undefined;
  } catch (error) {
    return error instanceof AppError ? error.code : "unexpected";
  }
}

describe("verifyOwnerAuth", () => {
  it("should accept the wallet's own signature over the exact challenge", async () => {
    const sig = await wallet.signTypedData(
      ownerAuthTypedData(domain, ownerChallenge),
    );
    expect(
      await verifyOwnerAuth(ctx, ownerChallenge, sig, wallet.address),
    ).toBe(wallet.address);
  });

  it("should reject another wallet, a tampered field and garbage (SIGNATURE_INVALID)", async () => {
    const sig = await other.signTypedData(
      ownerAuthTypedData(domain, ownerChallenge),
    );
    expect(
      await code(verifyOwnerAuth(ctx, ownerChallenge, sig, wallet.address)),
    ).toBe("SIGNATURE_INVALID");
    const own = await wallet.signTypedData(
      ownerAuthTypedData(domain, ownerChallenge),
    );
    expect(
      await code(
        verifyOwnerAuth(
          ctx,
          { ...ownerChallenge, tokenId: 2n },
          own,
          wallet.address,
        ),
      ),
    ).toBe("SIGNATURE_INVALID");
    expect(
      await code(
        verifyOwnerAuth(ctx, ownerChallenge, "0x1234", wallet.address),
      ),
    ).toBe("SIGNATURE_INVALID");
  });

  it("should reject a challenge for another chain (CHAIN_ID_MISMATCH) and an expired one", async () => {
    const foreign = { ...ownerChallenge, chainId: 295n };
    const sig = await wallet.signTypedData(
      ownerAuthTypedData(buildDomain(REGISTRY, 295), foreign),
    );
    expect(await code(verifyOwnerAuth(ctx, foreign, sig, wallet.address))).toBe(
      "CHAIN_ID_MISMATCH",
    );
    const stale = { ...ownerChallenge, expiresAt: 1_799_999_999n };
    const staleSig = await wallet.signTypedData(
      ownerAuthTypedData(domain, stale),
    );
    expect(
      await code(verifyOwnerAuth(ctx, stale, staleSig, wallet.address)),
    ).toBe("NONCE_INVALID_OR_EXPIRED");
  });

  it("should never accept a KeyGateChallenge signature as authentication (R-1a)", async () => {
    const keyGateSig = await wallet.signTypedData(
      keyGateTypedData(domain, {
        assetId: ASSET,
        purpose: "owner",
        receiptHash: `0x${"00".repeat(32)}`,
      }),
    );
    expect(
      await code(
        verifyOwnerAuth(ctx, ownerChallenge, keyGateSig, wallet.address),
      ),
    ).toBe("SIGNATURE_INVALID");
  });
});

describe("recoverLicenseeAuth / assertEoa", () => {
  it("should recover the signer of a LicenseeAuthChallenge", async () => {
    const challenge = {
      nonce: NONCE,
      chainId: 296n,
      receiptHash: `0x${"d4".repeat(32)}` as Hex,
      expiresAt: 1_800_000_100n,
    };
    const sig = await wallet.signTypedData(
      licenseeAuthTypedData(domain, challenge),
    );
    expect(await recoverLicenseeAuth(ctx, challenge, sig)).toBe(wallet.address);
    const otherSig = await other.signTypedData(
      licenseeAuthTypedData(domain, challenge),
    );
    expect(await recoverLicenseeAuth(ctx, challenge, otherSig)).toBe(
      other.address,
    );
  });

  it("should reject contract wallets and accept EOAs / unknown accounts", async () => {
    await expect(
      assertEoa(async () => "0x6080", wallet.address),
    ).rejects.toMatchObject({ code: "CONTRACT_WALLET_UNSUPPORTED" });
    await expect(
      assertEoa(async () => "0x", wallet.address),
    ).resolves.toBeUndefined();
    await expect(
      assertEoa(async () => undefined, wallet.address),
    ).resolves.toBeUndefined();
  });
});
