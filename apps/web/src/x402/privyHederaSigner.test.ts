import { PublicKey, Transaction, TransferTransaction } from "@hiero-ledger/sdk";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import type { PaymentRequirements } from "@x402/core/types";
import { describe, expect, it, vi } from "vitest";

import {
  createHederaTransactionSigner,
  createPrivyHederaSigner,
  recoverWalletPublicKey,
  toCompactSignature,
} from "./privyHederaSigner";

const PRIV = new Uint8Array(32).fill(3);

// secp256k1 group order — used to synthesize a high-S signature.
const SECP256K1_N = BigInt(
  "0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141",
);

function evmAddressOf(priv: Uint8Array): string {
  const uncompressed = secp256k1.getPublicKey(priv, false);
  return `0x${bytesToHex(keccak_256(uncompressed.slice(1)).slice(-20))}`;
}

// stand-in for Privy's provider.request({ method: "secp256k1_sign" }):
// signs the given 32-byte digest raw and returns 0x + 64-byte r||s.
const fakeSignRawHash = async (hashHex: string): Promise<string> => {
  const digest = Uint8Array.from(
    (hashHex.startsWith("0x") ? hashHex.slice(2) : hashHex).match(/.{2}/g)!,
    (b) => Number.parseInt(b, 16),
  );
  return `0x${bytesToHex(secp256k1.sign(digest, PRIV).toCompactRawBytes())}`;
};

const requirements: PaymentRequirements = {
  scheme: "exact",
  network: "hedera:testnet",
  asset: "0.0.0",
  payTo: "0.0.98",
  amount: "1000",
  maxTimeoutSeconds: 180,
  resource: "http://localhost:4021/premium",
  description: "test",
  mimeType: "application/json",
  extra: { feePayer: "0.0.800" },
} as unknown as PaymentRequirements;

describe("toCompactSignature", () => {
  it("round-trips an already-low-S 64-byte signature and stays low-S", () => {
    const sig = secp256k1.sign(new Uint8Array(32).fill(7), PRIV);
    expect(sig.hasHighS()).toBe(false);
    const compact = sig.toCompactRawBytes();
    const out = toCompactSignature(bytesToHex(compact));
    expect(out).toEqual(compact);
    expect(secp256k1.Signature.fromCompact(out).hasHighS()).toBe(false);
  });

  it("normalizes a high-S signature to low-S", () => {
    const sig = secp256k1.sign(new Uint8Array(32).fill(7), PRIV);
    const highS = SECP256K1_N - sig.s;
    const rHex = sig.r.toString(16).padStart(64, "0");
    const sHex = highS.toString(16).padStart(64, "0");
    const raw = hexToBytes(`${rHex}${sHex}`);
    expect(secp256k1.Signature.fromCompact(raw).hasHighS()).toBe(true);
    const out = toCompactSignature(bytesToHex(raw));
    expect(secp256k1.Signature.fromCompact(out).hasHighS()).toBe(false);
    // normalized s equals n - highS, i.e. the original low s
    expect(secp256k1.Signature.fromCompact(out).s).toBe(sig.s);
  });

  it("drops the trailing recovery byte from a 65-byte signature", () => {
    const sig = secp256k1.sign(new Uint8Array(32).fill(7), PRIV);
    const withRecovery = new Uint8Array(65);
    withRecovery.set(sig.toCompactRawBytes(), 0);
    withRecovery[64] = 1;
    expect(toCompactSignature(`0x${bytesToHex(withRecovery)}`)).toHaveLength(
      64,
    );
  });

  it("throws on an unexpected length", () => {
    expect(() => toCompactSignature("0x1234")).toThrow("length");
  });
});

describe("createHederaTransactionSigner", () => {
  it("signs keccak256(bodyBytes) and returns a low-S 64-byte r||s", async () => {
    const sign = createHederaTransactionSigner(fakeSignRawHash);
    const body = new Uint8Array(48).fill(9);
    const sig = await sign(body);
    expect(sig).toHaveLength(64);
    const parsed = secp256k1.Signature.fromCompact(sig);
    expect(parsed.hasHighS()).toBe(false);
    const pub = secp256k1.getPublicKey(PRIV, true);
    expect(secp256k1.verify(sig, keccak_256(body), pub)).toBe(true);
  });
});

describe("recoverWalletPublicKey", () => {
  it("recovers the wallet's ECDSA public key from a probe signature", async () => {
    const key = await recoverWalletPublicKey(
      evmAddressOf(PRIV),
      fakeSignRawHash,
    );
    expect(key.toStringRaw()).toBe(
      bytesToHex(secp256k1.getPublicKey(PRIV, true)),
    );
  });

  it("throws when the signature does not match the expected address", async () => {
    await expect(
      recoverWalletPublicKey(
        "0x0000000000000000000000000000000000000000",
        fakeSignRawHash,
      ),
    ).rejects.toThrow();
  });
});

describe("createPrivyHederaSigner", () => {
  const signer = createPrivyHederaSigner({
    accountId: "0.0.5005",
    evmAddress: evmAddressOf(PRIV),
    signRawHash: fakeSignRawHash,
    nodeAccountIds: ["0.0.3"],
  });

  it("exposes the payer account id", () => {
    expect(signer.accountId).toBe("0.0.5005");
  });

  it("builds a base64 transfer that round-trips and nets to zero", async () => {
    const base64 =
      await signer.createPartiallySignedTransferTransaction(requirements);
    const tx = Transaction.fromBytes(
      Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)),
    );
    expect(tx).toBeInstanceOf(TransferTransaction);

    const transfers = (tx as TransferTransaction).hbarTransfers;
    let net = 0n;
    for (const [, amount] of transfers) {
      net += BigInt(amount.toTinybars().toString());
    }
    expect(net).toBe(0n);
    const payerEntry = [...transfers].find(
      ([account]) => account.toString() === "0.0.5005",
    );
    expect(payerEntry?.[1].toTinybars().toString()).toBe("-1000");
  });

  it("attaches a signature that cryptographically verifies against the wallet key", async () => {
    const base64 =
      await signer.createPartiallySignedTransferTransaction(requirements);
    const tx = Transaction.fromBytes(
      Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)),
    );
    const publicKey = PublicKey.fromStringECDSA(
      bytesToHex(secp256k1.getPublicKey(PRIV, true)),
    );
    expect(publicKey.verifyTransaction(tx)).toBe(true);
  });

  it("calls signRawHash once per node plus one probe", async () => {
    const counting = vi.fn(fakeSignRawHash);
    const defaultNodeSigner = createPrivyHederaSigner({
      accountId: "0.0.5005",
      evmAddress: evmAddressOf(PRIV),
      signRawHash: counting,
      // omit nodeAccountIds -> DEFAULT_NODE_ACCOUNT_IDS (single node)
    });
    await defaultNodeSigner.createPartiallySignedTransferTransaction(
      requirements,
    );
    // 1 probe (public-key recovery) + 1 per default node
    expect(counting).toHaveBeenCalledTimes(2);
  });

  it("rejects an unsupported network", async () => {
    await expect(
      signer.createPartiallySignedTransferTransaction({
        ...requirements,
        network: "solana:mainnet",
      } as unknown as PaymentRequirements),
    ).rejects.toThrow("network");
  });

  it("rejects non-HBAR assets", async () => {
    await expect(
      signer.createPartiallySignedTransferTransaction({
        ...requirements,
        asset: "0.0.429274",
      } as PaymentRequirements),
    ).rejects.toThrow("HBAR");
  });

  it("rejects a missing feePayer", async () => {
    await expect(
      signer.createPartiallySignedTransferTransaction({
        ...requirements,
        extra: {},
      } as PaymentRequirements),
    ).rejects.toThrow("feePayer");
  });
});
