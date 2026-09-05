import { PublicKey } from "@hiero-ledger/sdk";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex } from "@noble/hashes/utils";

function normalizeEvmAddress(address: string): string {
  const clean = (
    address.startsWith("0x") ? address.slice(2) : address
  ).toLowerCase();
  if (clean.length !== 40 || /[^0-9a-f]/.test(clean)) {
    throw new Error(`invalid EVM address: ${address}`);
  }
  return clean;
}

/**
 * Recovers the secp256k1 public key that produced `signature` (64-byte compact
 * r||s) over `keccak256(message)`, choosing the recovery id whose derived
 * Ethereum address equals `expectedEvmAddress`. Returns a Hedera `PublicKey`
 * (ECDSA) built from the 33-byte compressed encoding.
 */
export function recoverEcdsaPublicKey(
  message: Uint8Array,
  signature: Uint8Array,
  expectedEvmAddress: string,
): PublicKey {
  const want = normalizeEvmAddress(expectedEvmAddress);
  const digest = keccak_256(message);

  for (let recovery = 0; recovery < 4; recovery += 1) {
    try {
      const sig =
        secp256k1.Signature.fromCompact(signature).addRecoveryBit(recovery);
      const point = sig.recoverPublicKey(digest);
      const uncompressed = point.toRawBytes(false); // 65 bytes, 0x04 prefix
      const derived = bytesToHex(keccak_256(uncompressed.slice(1)).slice(-20));
      if (derived === want) {
        return PublicKey.fromStringECDSA(bytesToHex(point.toRawBytes(true)));
      }
    } catch {
      // wrong recovery id — keep trying
    }
  }

  throw new Error("could not recover a public key matching the wallet address");
}
