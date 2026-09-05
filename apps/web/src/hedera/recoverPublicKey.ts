import { PublicKey } from "@hiero-ledger/sdk";
import { bytesToHex } from "@noble/hashes/utils";
import { recoverCompressedPublicKey } from "@truenft/shared";

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
  return PublicKey.fromStringECDSA(
    bytesToHex(
      recoverCompressedPublicKey(message, signature, expectedEvmAddress),
    ),
  );
}
