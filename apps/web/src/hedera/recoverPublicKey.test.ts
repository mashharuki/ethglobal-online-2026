import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex } from "@noble/hashes/utils";
import { describe, expect, it } from "vitest";

import { recoverEcdsaPublicKey } from "./recoverPublicKey";

// deterministic throwaway key — test only
const PRIV = hexToBytes32(
  "1111111111111111111111111111111111111111111111111111111111111111",
);

function hexToBytes32(hex: string): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function evmAddressOf(priv: Uint8Array): string {
  const uncompressed = secp256k1.getPublicKey(priv, false); // 65 bytes
  return `0x${bytesToHex(keccak_256(uncompressed.slice(1)).slice(-20))}`;
}

describe("recoverEcdsaPublicKey", () => {
  it("recovers the key whose EVM address matches", () => {
    const message = new Uint8Array(32).fill(7);
    const digest = keccak_256(message);
    const sig = secp256k1.sign(digest, PRIV).toCompactRawBytes();

    const publicKey = recoverEcdsaPublicKey(message, sig, evmAddressOf(PRIV));

    // Hedera compressed ECDSA key hex is 33 bytes / 66 chars
    expect(publicKey.toStringRaw().length).toBe(66);
    // and it must correspond to the same underlying point
    const expected = bytesToHex(secp256k1.getPublicKey(PRIV, true));
    expect(publicKey.toStringRaw()).toBe(expected);
  });

  it("throws when no recovery id matches the expected address", () => {
    const message = new Uint8Array(32).fill(7);
    const digest = keccak_256(message);
    const sig = secp256k1.sign(digest, PRIV).toCompactRawBytes();
    expect(() =>
      recoverEcdsaPublicKey(
        message,
        sig,
        "0x0000000000000000000000000000000000000000",
      ),
    ).toThrow();
  });

  it("throws on a malformed expected address", () => {
    expect(() =>
      recoverEcdsaPublicKey(new Uint8Array(32), new Uint8Array(64), "0x1234"),
    ).toThrow("EVM address");
  });
});
