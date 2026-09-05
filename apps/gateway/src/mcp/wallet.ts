import { PrivyClient } from "@privy-io/node";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Env } from "../env";

/**
 * The MCP payment wallet (tasks.md T092, research.md R-9). The gateway never holds the raw
 * key: every signature is a Privy server-wallet RPC (`eth_signTypedData_v4` for the EIP-712
 * challenges, `secp256k1_sign` for the Hedera transaction digest). Spend control lives in
 * mcp/session.ts (per Mcp-Session-Id hard cap, R-9a) because a raw-hash signature carries no
 * transaction structure Privy could apply a policy to - disclosed in CONFIG.md / README.
 */
type TypedDataInput = {
  readonly domain: Record<string, unknown>;
  readonly types: Record<
    string,
    ReadonlyArray<{ readonly name: string; readonly type: string }>
  >;
  readonly primaryType: string;
  readonly message: Record<string, unknown>;
};

export type AgentWallet = {
  /** EVM address of the wallet (the licensee on every receipt it buys) */
  address: Address;
  signTypedData(typedData: TypedDataInput): Promise<Hex>;
  /** secp256k1 signature (r||s||v, 65 bytes) over a 32-byte digest, no prefixing */
  signRawHash(hash: Hex): Promise<Hex>;
};

export class AgentWalletUnavailableError extends Error {
  override readonly name = "AgentWalletUnavailableError";
}

function stringifyBigints<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
  ) as T;
}

/** Privy server wallet (`PRIVY_WALLET_ID` / `PRIVY_WALLET_ADDRESS` + app credentials). */
export function createPrivyAgentWallet(env: Env): AgentWallet {
  const {
    PRIVY_APP_ID,
    PRIVY_APP_SECRET,
    PRIVY_WALLET_ID,
    PRIVY_WALLET_ADDRESS,
  } = env;
  if (
    PRIVY_APP_ID === undefined ||
    PRIVY_APP_SECRET === undefined ||
    PRIVY_WALLET_ID === undefined ||
    PRIVY_WALLET_ADDRESS === undefined
  ) {
    throw new AgentWalletUnavailableError(
      "PRIVY_APP_ID / PRIVY_APP_SECRET / PRIVY_WALLET_ID / PRIVY_WALLET_ADDRESS are not all set",
    );
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(PRIVY_WALLET_ADDRESS)) {
    throw new AgentWalletUnavailableError(
      "PRIVY_WALLET_ADDRESS is not an address",
    );
  }
  const client = new PrivyClient({
    appId: PRIVY_APP_ID,
    appSecret: PRIVY_APP_SECRET,
  });
  return {
    address: PRIVY_WALLET_ADDRESS as Address,
    signTypedData: async (typedData) => {
      const td = stringifyBigints(typedData);
      const types: Record<string, Array<{ name: string; type: string }>> = {};
      for (const [name, fields] of Object.entries(td.types)) {
        types[name] = fields.map((f) => ({ name: f.name, type: f.type }));
      }
      const result = await client
        .wallets()
        .ethereum()
        .signTypedData(PRIVY_WALLET_ID, {
          params: {
            typed_data: {
              domain: td.domain,
              types,
              primary_type: td.primaryType,
              message: td.message,
            },
          },
        });
      return result.signature as Hex;
    },
    signRawHash: async (hash) => {
      const result = await client.wallets()._rpc(PRIVY_WALLET_ID, {
        method: "secp256k1_sign",
        params: { hash },
      });
      if (result.method !== "secp256k1_sign" || result.data === undefined) {
        throw new Error("privy secp256k1_sign answered with another method");
      }
      return result.data.signature as Hex;
    },
  };
}

/**
 * Local-key wallet for the node test suite (a viem account). Not used on the demo path: the
 * deployed gateway only ever constructs the Privy wallet.
 */
export function createLocalAgentWallet(privateKey: Hex): AgentWallet {
  const account = privateKeyToAccount(privateKey);
  return {
    address: account.address,
    signTypedData: (typedData) =>
      account.signTypedData(
        typedData as unknown as Parameters<typeof account.signTypedData>[0],
      ),
    signRawHash: (hash) => account.sign({ hash }),
  };
}
