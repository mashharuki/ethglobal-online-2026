type MirrorAccountResponse = {
  account: string;
  balance?: { balance?: number };
  key?: { _type?: string; key?: string } | null;
};

export type ResolvedHederaAccount = {
  accountId: string;
  balanceTinybars: bigint;
  /**
   * `false` when the account is a "hollow" account (HIP-583): funded through an
   * EVM-address alias but never activated by signing a transaction, so the
   * network holds no public key for it. The x402 facilitator resolves the
   * payer key from the Mirror Node to verify the payment signature, so a
   * payment from a keyless account is rejected — it must be activated first.
   */
  hasKey: boolean;
};

/**
 * Resolves the Hedera account that a Privy embedded wallet's EVM address maps
 * to, using the public Mirror Node REST API. Returns `null` when no account
 * exists yet (HTTP 404 — the wallet has not been funded / lazy-created).
 */
export async function resolveHederaAccount(
  evmAddress: string,
  mirrorNodeUrl: string,
): Promise<ResolvedHederaAccount | null> {
  const address = evmAddress.toLowerCase();
  const response = await fetch(`${mirrorNodeUrl}/api/v1/accounts/${address}`);

  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(
      `Mirror Node request failed with status ${response.status}`,
    );
  }

  const body = (await response.json()) as MirrorAccountResponse;
  return {
    accountId: body.account,
    balanceTinybars: BigInt(body.balance?.balance ?? 0),
    hasKey: typeof body.key?.key === "string" && body.key.key.length > 0,
  };
}
