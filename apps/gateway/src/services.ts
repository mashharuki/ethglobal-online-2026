import type { Address, Hex } from "viem";
import { type ChainContext, createChainContext } from "./chain/clients";
import {
  readAccessEpoch,
  readCreatorOf,
  readLicenseEpoch,
  readPolicyHash,
  readReceiptStatus,
  readResourceHash,
} from "./chain/reads";
import { receiptHashesFromReceipt, waitForTx } from "./chain/writes";
import type { Db } from "./db/types";
import { submitViaOperatorQueue } from "./do/client";
import type { Env } from "./env";
import { createGraphFetch, type GraphFetch } from "./graph/cache";
import { createManifestPorts, createReleasePorts } from "./keygate/ports";
import type { ReleasePorts } from "./keygate/release";
import {
  manifestHttpUrl,
  type ResolvedAsset,
  resolveAsset,
} from "./manifest/resolver";
import { resolveHederaAccount } from "./mcp/hedera";
import { McpToolError } from "./mcp/toolError";
import { type AgentWallet, createPrivyAgentWallet } from "./mcp/wallet";
import {
  createFacilitatorClient,
  resolvePayerEvmAddress,
} from "./x402/facilitator";
import { randomNonce, type SettlePorts } from "./x402/settle";

/**
 * Everything the route handlers need, built once per request from the Worker env
 * (production, `createServices`) or from fakes (tests). Routes only ever see this interface;
 * chain access always goes through viem reads / the Durable Objects underneath.
 */
export type Services = {
  env: Env;
  db: Db;
  release: ReleasePorts;
  settle: SettlePorts;
  graph: GraphFetch;
  ipfsGateway: string;
  resolveAsset(assetId: Hex): Promise<ResolvedAsset>;
  /** discovery only: manifest JSON at an ipfs:// / https:// URI */
  fetchManifest(uri: string): Promise<unknown>;
  /** encrypted content bytes at an ipfs:// / https:// URI (MCP decrypt_content) */
  fetchBytes(uri: string): Promise<Uint8Array>;
  /** MCP payment wallet (Privy server wallet) and its Hedera account */
  agent: {
    wallet(): AgentWallet;
    accountId(): Promise<string>;
  };
  /** MCP spend policy: hard cap per Mcp-Session-Id, tinybar */
  mcpSpendCapTinybar: bigint;
  /** admin: creator of a token (RightsNFT.creatorOf) */
  creatorOf(tokenId: bigint): Promise<Address>;
  licenseEpoch(tokenId: bigint): Promise<bigint>;
  /** admin: bumpLicenseEpoch through the operator queue, returns the tx hash */
  bumpLicenseEpoch(input: {
    tokenId: bigint;
    fromEpoch: bigint;
    idempotencyKey: string;
  }): Promise<Hex>;
  waitForTx(txHash: Hex): Promise<void>;
  now(): Date;
};

/** fail closed: an unset / malformed cap allows nothing */
export function parseSpendCap(raw: string | undefined): bigint {
  return typeof raw === "string" && /^\d{1,30}$/.test(raw) ? BigInt(raw) : 0n;
}

export function createServices(env: Env, db: Db): Services {
  const ctx: ChainContext = createChainContext(env);
  const release = createReleasePorts(env, db);
  const manifestPorts = createManifestPorts(env, ctx);
  const graph = createGraphFetch(env.SUBGRAPH_URL);
  const resolve = (assetId: Hex): Promise<ResolvedAsset> =>
    resolveAsset(manifestPorts, ctx.deployment, assetId);
  const settle: SettlePorts = {
    env,
    db,
    deployment: ctx.deployment,
    mode: env.SETTLEMENT_MODE,
    settlementAccountId: env.SETTLEMENT_ACCOUNT_ID,
    facilitator: createFacilitatorClient(env.X402_FACILITATOR_URL),
    resolveAsset: resolve,
    quoteReads: async (tokenId) => {
      const blockNumber = await ctx.publicClient.getBlockNumber();
      const at = { blockNumber };
      const [licenseEpoch, accessEpoch, policyHash, resourceHash] =
        await Promise.all([
          readLicenseEpoch(ctx, tokenId, at),
          readAccessEpoch(ctx, tokenId, at),
          readPolicyHash(ctx, tokenId, at),
          readResourceHash(ctx, tokenId, at),
        ]);
      return { licenseEpoch, accessEpoch, policyHash, resourceHash };
    },
    operator: (job) => submitViaOperatorQueue(env, job),
    receiptHashesFromTx: (txHash) => receiptHashesFromReceipt(ctx, txHash),
    receiptIssued: async (receiptHash) =>
      (await readReceiptStatus(ctx, receiptHash)).issued,
    payerEvmAddress: (accountId) =>
      resolvePayerEvmAddress(env.HEDERA_MIRROR_URL, accountId),
    now: () => new Date(),
    randomNonce,
  };
  return {
    env,
    db,
    release,
    settle,
    graph,
    ipfsGateway: env.IPFS_GATEWAY_URL,
    resolveAsset: resolve,
    fetchManifest: (uri) => manifestPorts.fetchManifest(uri),
    fetchBytes: async (uri) => {
      const response = await fetch(manifestHttpUrl(uri, env.IPFS_GATEWAY_URL));
      if (!response.ok) {
        throw new Error(`content fetch failed (${response.status})`);
      }
      return new Uint8Array(await response.arrayBuffer());
    },
    agent: {
      wallet: () => createPrivyAgentWallet(env),
      accountId: async () => {
        const wallet = createPrivyAgentWallet(env);
        const account = await resolveHederaAccount(
          env.HEDERA_MIRROR_URL,
          wallet.address,
        );
        if (account === undefined) {
          throw new McpToolError(
            "INSUFFICIENT_AGENT_BALANCE",
            "the agent wallet has no Hedera account yet: fund its EVM address first",
          );
        }
        if (!account.hasKey) {
          throw new McpToolError(
            "INSUFFICIENT_AGENT_BALANCE",
            "the agent account is hollow (no key): activate it by signing one transaction",
          );
        }
        return account.accountId;
      },
    },
    mcpSpendCapTinybar: parseSpendCap(env.MCP_SESSION_SPEND_CAP_TINYBAR),
    creatorOf: (tokenId) => readCreatorOf(ctx, tokenId),
    licenseEpoch: (tokenId) => readLicenseEpoch(ctx, tokenId),
    bumpLicenseEpoch: (input) =>
      submitViaOperatorQueue(env, { kind: "bumpLicenseEpoch", ...input }),
    waitForTx: async (txHash) => {
      await waitForTx(ctx, txHash, "bumpLicenseEpoch");
    },
    now: () => new Date(),
  };
}
