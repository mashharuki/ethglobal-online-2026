import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex } from "@noble/hashes/utils";
import { describe, expect, it } from "vitest";
import {
  recoverCompressedPublicKey,
  toCompactLowSSignature,
} from "../src/secp256k1";

// deterministic throwaway key - test only
const PRIV = new Uint8Array(32).fill(0x11);
const N = secp256k1.CURVE.n;

function evmAddressOf(priv: Uint8Array): string {
  const uncompressed = secp256k1.getPublicKey(priv, false);
  return `0x${bytesToHex(keccak_256(uncompressed.slice(1)).slice(-20))}`;
}

describe("toCompactLowSSignature", () => {
  it("should keep a low-S 64-byte signature unchanged, with or without 0x", () => {
    const sig = secp256k1
      .sign(keccak_256(new Uint8Array(32)), PRIV)
      .toCompactRawBytes();
    expect(toCompactLowSSignature(bytesToHex(sig))).toEqual(sig);
    expect(toCompactLowSSignature(`0x${bytesToHex(sig)}`)).toEqual(sig);
  });

  it("should drop a trailing recovery byte and canonicalize a high-S signature", () => {
    const sig = secp256k1.sign(keccak_256(new Uint8Array(32)), PRIV);
    const highS = new secp256k1.Signature(sig.r, N - sig.s).toCompactRawBytes();
    const withV = new Uint8Array(65);
    withV.set(highS, 0);
    withV[64] = 27;
    expect(toCompactLowSSignature(bytesToHex(withV))).toEqual(
      sig.toCompactRawBytes(),
    );
  });

  it("should reject other lengths", () => {
    expect(() => toCompactLowSSignature("0x1234")).toThrow("length");
  });
});

describe("recoverCompressedPublicKey", () => {
  it("should recover the compressed key whose EVM address matches", () => {
    const message = new Uint8Array(32).fill(7);
    const sig = secp256k1.sign(keccak_256(message), PRIV).toCompactRawBytes();
    const recovered = recoverCompressedPublicKey(
      message,
      sig,
      evmAddressOf(PRIV),
    );
    expect(bytesToHex(recovered)).toBe(
      bytesToHex(secp256k1.getPublicKey(PRIV, true)),
    );
  });

  it("should refuse a signature that does not belong to the address", () => {
    const message = new Uint8Array(32).fill(7);
    const sig = secp256k1.sign(keccak_256(message), PRIV).toCompactRawBytes();
    const other = new Uint8Array(32).fill(0x22);
    expect(() =>
      recoverCompressedPublicKey(message, sig, evmAddressOf(other)),
    ).toThrow("could not recover");
    expect(() => recoverCompressedPublicKey(message, sig, "0x12")).toThrow(
      "invalid EVM address",
    );
  });
});
