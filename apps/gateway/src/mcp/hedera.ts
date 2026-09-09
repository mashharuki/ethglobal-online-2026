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
 * Mirror node: the Hedera account an EVM address maps to, and whether it can actually pay
 * (MCP OAuth remediation - `hasKey` used to be checked but the real `balance` field was
 * never read, so a genuinely funded-but-empty-key account and an unreachable mirror node
 * were both silently treated the same as "not a balance problem"). `unreadable` is
 * deliberately a distinct outcome from a real zero balance: a network error or a malformed
 * response must never be reported as `AGENT_WALLET_UNAVAILABLE`/`INSUFFICIENT_AGENT_BALANCE`
 * (that would tell the caller to fund an account that may already be funded).
 */
export type HederaAccountView =
  | { kind: "absent" }
  | { kind: "unreadable"; reason: "network" | "status" | "malformed" }
  | { kind: "ok"; accountId: string; hasKey: boolean; balanceTinybar: bigint };

function parseMirrorBalance(value: unknown): bigint | undefined {
  if (typeof value === "number") {
    // the max HBAR supply in tinybar exceeds Number.MAX_SAFE_INTEGER - only trust a
    // number the mirror node sent if it round-trips exactly through the float. A balance
    // is never negative (Codex review: Number.isSafeInteger(-1) is true).
    return Number.isSafeInteger(value) && value >= 0
      ? BigInt(value)
      : undefined;
  }
  // the \d+ pattern already excludes a leading '-', so no separate sign check is needed here
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return BigInt(value);
  }
  return undefined;
}

export async function resolveHederaAccount(
  mirrorUrl: string,
  evmAddress: string,
  fetchImpl: typeof fetch = fetch,
): Promise<HederaAccountView> {
  const base = mirrorUrl.endsWith("/") ? mirrorUrl.slice(0, -1) : mirrorUrl;
  let response: Response;
  try {
    response = await fetchImpl(
      `${base}/api/v1/accounts/${evmAddress.toLowerCase()}`,
    );
  } catch {
    return { kind: "unreadable", reason: "network" };
  }
  if (response.status === 404) return { kind: "absent" };
  if (!response.ok) {
    return { kind: "unreadable", reason: "status" };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { kind: "unreadable", reason: "malformed" };
  }
  // Codex review: `body` can be JSON `null` (or any non-object) on a 200 response - casting
  // straight to a property-bag type and reading `.account` off it would throw instead of
  // reporting `unreadable`.
  if (typeof body !== "object" || body === null) {
    return { kind: "unreadable", reason: "malformed" };
  }
  const parsed = body as {
    account?: string;
    key?: { key?: string } | null;
    balance?: { balance?: unknown } | null;
  };
  if (typeof parsed.account !== "string") {
    return { kind: "unreadable", reason: "malformed" };
  }
  const balanceTinybar = parseMirrorBalance(parsed.balance?.balance);
  if (balanceTinybar === undefined) {
    return { kind: "unreadable", reason: "malformed" };
  }
  return {
    kind: "ok",
    accountId: parsed.account,
    hasKey: typeof parsed.key?.key === "string" && parsed.key.key.length > 0,
    balanceTinybar,
  };
}
