import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";

/**
 * secp256k1 helpers shared by the web app (Privy embedded wallet) and the gateway MCP wallet
 * (Privy server wallet): both sign Hedera transactions through a raw-hash signer and must turn
 * the returned Ethereum-style signature into what Hedera's ECDSA_SECP256K1 verification
 * expects. Pure noble code: runs in browsers, Workers and Node.
 */
function stripHex(hex: string): string {
  return hex.startsWith("0x") ? hex.slice(2) : hex;
}

/** Normalizes a hex signature (0x-prefixed or not, 64 or 65 bytes) to 64-byte low-S r||s. */
export function toCompactLowSSignature(sigHex: string): Uint8Array {
  const bytes = hexToBytes(stripHex(sigHex));
  if (bytes.length !== 64 && bytes.length !== 65) {
    throw new Error(`unexpected signature length: ${bytes.length}`);
  }
  // Hedera verifies with noble `secp256k1.verify`, whose default is `lowS: true`.
  const compact = bytes.length === 65 ? bytes.slice(0, 64) : bytes;
  return secp256k1.Signature.fromCompact(compact)
    .normalizeS()
    .toCompactRawBytes();
}

/** Ethereum address (lowercase hex, no prefix) of an uncompressed secp256k1 point. */
function evmAddressOf(uncompressed: Uint8Array): string {
  return bytesToHex(keccak_256(uncompressed.slice(1)).slice(-20));
}

/**
 * Recovers the compressed (33-byte) public key that produced `signature` (64-byte compact
 * r||s) over keccak256(message), choosing the recovery id whose Ethereum address equals
 * `expectedEvmAddress`. Wallets that never expose their public key (Privy) are identified
 * this way from one probe signature.
 */
export function recoverCompressedPublicKey(
  message: Uint8Array,
  signature: Uint8Array,
  expectedEvmAddress: string,
): Uint8Array {
  const want = stripHex(expectedEvmAddress).toLowerCase();
  if (want.length !== 40 || /[^0-9a-f]/.test(want)) {
    throw new Error(`invalid EVM address: ${expectedEvmAddress}`);
  }
  const digest = keccak_256(message);
  for (let recovery = 0; recovery < 4; recovery += 1) {
    try {
      const point = secp256k1.Signature.fromCompact(signature)
        .addRecoveryBit(recovery)
        .recoverPublicKey(digest);
      if (evmAddressOf(point.toRawBytes(false)) === want) {
        return point.toRawBytes(true);
      }
    } catch {
      // wrong recovery id - keep trying
    }
  }
  throw new Error("could not recover a public key matching the wallet address");
}
