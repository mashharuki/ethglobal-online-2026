import {
  AccountId,
  Hbar,
  type PublicKey,
  TransactionId,
  TransferTransaction,
} from "@hiero-ledger/sdk";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import type { PaymentRequirements } from "@x402/core/types";
import type { ClientHederaSigner } from "@x402/hedera";
import { isSupportedHederaNetwork } from "@x402/hedera";
import { recoverEcdsaPublicKey } from "../hedera/recoverPublicKey";
import { bytesToBase64 } from "../lib/encoding";

/**
 * Consensus node used to freeze the transfer offline (no gRPC client).
 *
 * A single node keeps the signing flow to one Privy prompt per transaction and
 * avoids a multi-node transaction that expires before every signature is
 * collected. Callers can override this via `options.nodeAccountIds`.
 */
const DEFAULT_NODE_ACCOUNT_IDS = ["0.0.3"];

export type SignRawHash = (hashHex: string) => Promise<string>;

export type PrivyHederaSignerOptions = {
  accountId: string;
  evmAddress: string;
  signRawHash: SignRawHash;
  nodeAccountIds?: string[];
};

/** Normalizes a hex signature (0x-prefixed or not, 64 or 65 bytes) to 64-byte r||s. */
export function toCompactSignature(sigHex: string): Uint8Array {
  const bytes = hexToBytes(sigHex.startsWith("0x") ? sigHex.slice(2) : sigHex);
  if (bytes.length !== 64 && bytes.length !== 65) {
    throw new Error(`unexpected signature length: ${bytes.length}`);
  }
  // Hedera verifies with noble-curves `secp256k1.verify`, which defaults to
  // `lowS: true`; canonicalize to low-S so a high-S Privy signature is accepted.
  const compact = bytes.length === 65 ? bytes.slice(0, 64) : bytes;
  return secp256k1.Signature.fromCompact(compact)
    .normalizeS()
    .toCompactRawBytes();
}

/**
 * Builds a `Transaction.signWith` callback that signs `keccak256(bodyBytes)`
 * through a Privy raw-hash signer and returns a canonical low-S 64-byte r||s —
 * the signature shape Hedera's ECDSA_SECP256K1 verification expects.
 */
export function createHederaTransactionSigner(
  signRawHash: SignRawHash,
): (bodyBytes: Uint8Array) => Promise<Uint8Array> {
  return async (bodyBytes) => {
    const digest = keccak_256(bodyBytes);
    const sigHex = await signRawHash(`0x${bytesToHex(digest)}`);
    return toCompactSignature(sigHex);
  };
}

/**
 * Recovers the Privy embedded wallet's secp256k1 public key by signing a fixed
 * probe digest and matching the recovered key against the wallet's EVM address.
 * The wallet never exposes its public key directly, so this is the only way to
 * obtain a Hedera `PublicKey` for it.
 */
export async function recoverWalletPublicKey(
  evmAddress: string,
  signRawHash: SignRawHash,
): Promise<PublicKey> {
  const probe = new Uint8Array(32);
  const probeSig = await createHederaTransactionSigner(signRawHash)(probe);
  return recoverEcdsaPublicKey(probe, probeSig, evmAddress);
}

/**
 * Builds a `ClientHederaSigner` backed by a Privy embedded EVM wallet.
 *
 * Mirrors `@x402/hedera`'s default `createClientHederaSigner`, except the
 * signing step goes through Privy's raw secp256k1 hash signing instead of a
 * local `PrivateKey`. The transaction is frozen with explicit node account ids
 * so no live gRPC client is needed in the browser.
 */
export function createPrivyHederaSigner(
  options: PrivyHederaSignerOptions,
): ClientHederaSigner {
  const { accountId, evmAddress, signRawHash } = options;
  const payer = AccountId.fromString(accountId);
  const nodeAccountIds = (
    options.nodeAccountIds ?? DEFAULT_NODE_ACCOUNT_IDS
  ).map((id) => AccountId.fromString(id));

  let cachedPublicKey: PublicKey | undefined;

  const resolvePublicKey = async (): Promise<PublicKey> => {
    cachedPublicKey ??= await recoverWalletPublicKey(evmAddress, signRawHash);
    return cachedPublicKey;
  };

  return {
    accountId: payer.toString(),
    createPartiallySignedTransferTransaction: async (
      requirements: PaymentRequirements,
    ): Promise<string> => {
      if (!isSupportedHederaNetwork(requirements.network)) {
        throw new Error(
          `unsupported Hedera network: ${String(requirements.network)}`,
        );
      }
      const feePayer = requirements.extra?.feePayer;
      if (typeof feePayer !== "string") {
        throw new Error("feePayer is required in paymentRequirements.extra");
      }
      const amount = BigInt(requirements.amount);
      if (amount <= 0n) {
        throw new Error("amount must be greater than zero");
      }
      if (requirements.asset !== "0.0.0") {
        throw new Error("only native HBAR (asset 0.0.0) is supported");
      }

      const publicKey = await resolvePublicKey();
      const payTo = AccountId.fromString(requirements.payTo);

      const tx = new TransferTransaction()
        .addHbarTransfer(payer, Hbar.fromTinybars((-amount).toString()))
        .addHbarTransfer(payTo, Hbar.fromTinybars(amount.toString()))
        .setTransactionId(
          TransactionId.generate(AccountId.fromString(feePayer)),
        )
        .setNodeAccountIds(nodeAccountIds)
        .freeze();

      await tx.signWith(publicKey, createHederaTransactionSigner(signRawHash));

      return bytesToBase64(tx.toBytes());
    },
  };
}
