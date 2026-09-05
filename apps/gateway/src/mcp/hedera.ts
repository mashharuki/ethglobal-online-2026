import {
  AccountId,
  Hbar,
  PublicKey,
  TransactionId,
  TransferTransaction,
} from "@hiero-ledger/sdk";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex } from "@noble/hashes/utils";
import {
  recoverCompressedPublicKey,
  toCompactLowSSignature,
} from "@truenft/shared";
import type { AgentWallet } from "./wallet";

/**
 * x402 `exact` payload for hedera:testnet, built offline (tasks.md T094): a partially signed
 * HAPI TransferTransaction from the agent account to `payTo`, with the facilitator as fee
 * payer (transaction id) and a single consensus node so one raw-hash signature suffices.
 * Same construction as apps/web/src/x402/privyHederaSigner.ts (Privy embedded wallet there,
 * Privy server wallet here); the secp256k1 plumbing is packages/shared/src/secp256k1.ts.
 */
const DEFAULT_NODE_ACCOUNT_IDS = ["0.0.3"];

export type TransferSpec = {
  payerAccountId: string;
  payTo: string;
  amountTinybar: bigint;
  feePayer: string;
  nodeAccountIds?: string[];
};

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Signs keccak256(bodyBytes) through the wallet and returns 64-byte low-S r||s. */
function transactionSigner(
  wallet: AgentWallet,
): (bodyBytes: Uint8Array) => Promise<Uint8Array> {
  return async (bodyBytes) => {
    const sig = await wallet.signRawHash(
      `0x${bytesToHex(keccak_256(bodyBytes))}`,
    );
    return toCompactLowSSignature(sig);
  };
}

/** The wallet never exposes its public key: recover it from a probe signature. */
async function recoverWalletPublicKey(wallet: AgentWallet): Promise<PublicKey> {
  const probe = new Uint8Array(32);
  const sig = await transactionSigner(wallet)(probe);
  return PublicKey.fromStringECDSA(
    bytesToHex(recoverCompressedPublicKey(probe, sig, wallet.address)),
  );
}

/** base64(HAPI TransferTransaction bytes), signed by the agent, fee-payer signature pending. */
export async function buildSignedTransfer(
  wallet: AgentWallet,
  spec: TransferSpec,
): Promise<string> {
  if (spec.amountTinybar <= 0n) throw new Error("amount must be positive");
  const payer = AccountId.fromString(spec.payerAccountId);
  const publicKey = await recoverWalletPublicKey(wallet);
  const tx = new TransferTransaction()
    .addHbarTransfer(payer, Hbar.fromTinybars((-spec.amountTinybar).toString()))
    .addHbarTransfer(
      AccountId.fromString(spec.payTo),
      Hbar.fromTinybars(spec.amountTinybar.toString()),
    )
    .setTransactionId(
      TransactionId.generate(AccountId.fromString(spec.feePayer)),
    )
    .setNodeAccountIds(
      (spec.nodeAccountIds ?? DEFAULT_NODE_ACCOUNT_IDS).map((id) =>
        AccountId.fromString(id),
      ),
    )
    .freeze();
  await tx.signWith(publicKey, transactionSigner(wallet));
  return bytesToBase64(tx.toBytes());
}

/**
 * Mirror node: the Hedera account an EVM address maps to. `undefined` when it does not exist
 * yet; a hollow account (no key) cannot sign x402 payments and is reported as such.
 */
export async function resolveHederaAccount(
  mirrorUrl: string,
  evmAddress: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ accountId: string; hasKey: boolean } | undefined> {
  const base = mirrorUrl.endsWith("/") ? mirrorUrl.slice(0, -1) : mirrorUrl;
  const response = await fetchImpl(
    `${base}/api/v1/accounts/${evmAddress.toLowerCase()}`,
  );
  if (response.status === 404) return undefined;
  if (!response.ok) {
    throw new Error(`mirror node answered ${response.status}`);
  }
  const body = (await response.json()) as {
    account?: string;
    key?: { key?: string } | null;
  };
  if (typeof body.account !== "string") return undefined;
  return {
    accountId: body.account,
    hasKey: typeof body.key?.key === "string" && body.key.key.length > 0,
  };
}
