import {
  AccountId,
  Client,
  Hbar,
  type PublicKey,
  TransactionId,
  TransferTransaction,
} from "@hiero-ledger/sdk";

import {
  createHederaTransactionSigner,
  type SignRawHash,
} from "../x402/privyHederaSigner";

/**
 * Recipient of the 1-tinybar activation transfer: the Hedera node reward
 * account. It exists on every network and accepts inbound HBAR, so the
 * transfer only needs the payer's own signature to succeed.
 */
const ACTIVATION_SINK = "0.0.800";

/**
 * Completes a "hollow" Hedera account (HIP-583) so the network records its
 * public key.
 *
 * A hollow account — one lazy-created by a transfer to its EVM-address alias —
 * has no on-chain key until it signs a transaction where its signature is
 * required. This sends 1 tinybar from the account to the node reward account,
 * paid for and signed by the account itself; the network then fills in the
 * account's key from that signature.
 *
 * This is the only place the app talks to a consensus node from the browser
 * (via the SDK's gRPC-web client), and only for this one-time step. Every
 * payment path stays offline.
 *
 * @returns the activation transaction id
 */
export async function activateHollowAccount(
  accountId: string,
  publicKey: PublicKey,
  signRawHash: SignRawHash,
): Promise<string> {
  const client = Client.forTestnet();
  try {
    const payer = AccountId.fromString(accountId);
    const tx = new TransferTransaction()
      .addHbarTransfer(payer, Hbar.fromTinybars(-1))
      .addHbarTransfer(
        AccountId.fromString(ACTIVATION_SINK),
        Hbar.fromTinybars(1),
      )
      .setTransactionId(TransactionId.generate(payer))
      .freezeWith(client);

    await tx.signWith(publicKey, createHederaTransactionSigner(signRawHash));

    const response = await tx.execute(client);
    const receipt = await response.getReceipt(client);
    const status = receipt.status.toString();
    if (status !== "SUCCESS") {
      throw new Error(`account activation failed with status ${status}`);
    }
    return response.transactionId.toString();
  } finally {
    client.close();
  }
}
