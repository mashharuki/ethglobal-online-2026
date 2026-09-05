import type { PGlite } from "@electric-sql/pglite";
import {
  buildDomain,
  computeReceiptHash,
  keyGateTypedData,
  manifestToPolicyInput,
  type RightsReceipt,
  TransferMode,
} from "@truenft/shared";
import { Hono } from "hono";
import { type Address, type Hex, hexToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/types";
import type { ReceiptParamsJson } from "../../src/do/operatorQueueCore";
import type { Env } from "../../src/env";
import { handleError } from "../../src/errors";
import type { GraphFetch } from "../../src/graph/cache";
import type { ReleasePorts } from "../../src/keygate/release";
import { AssetNotFoundError } from "../../src/manifest/resolver";
import { type AppEnv, registerRoutes } from "../../src/routes";
import type { Services } from "../../src/services";
import type { PaymentPayload } from "../../src/x402/facilitator";
import type { ReceiptQuote, SettlePorts } from "../../src/x402/settle";
import {
  buildAsset,
  CHAIN_ID,
  createTestDb,
  MemoryKv,
  makeEnv,
  RIGHTS_NFT,
  RIGHTS_REGISTRY,
  type TestAsset,
} from "./helpers";

/**
 * HTTP-level tests for the routes (T086-T091 slices; T063 402 shape) with PGlite and
 * injected chain / facilitator / operator fakes. Real Hedera + Blocky402 runs are the
 * Phase 8 E2E gate (BLOCKED until deploy + probe).
 */
const owner = privateKeyToAccount(`0x${"a1".repeat(32)}`);
const creator = privateKeyToAccount(`0x${"c0".repeat(32)}`);
const buyer = privateKeyToAccount(`0x${"b7".repeat(32)}`);
const stranger = privateKeyToAccount(`0x${"b2".repeat(32)}`);
const NOW = new Date("2026-09-06T12:00:00Z");
const domain = buildDomain(RIGHTS_REGISTRY, CHAIN_ID);
const ZERO32 = `0x${"00".repeat(32)}` as Hex;
const PAYER_ACCOUNT = "0.0.4242";

let db: Db;
let client: PGlite;
let env: Env;
let asset: TestAsset;
let app: Hono<AppEnv>;
let fake: Fake;

type Fake = {
  licenseEpoch: bigint;
  accessEpoch: bigint;
  tokenOwner: Address;
  creator: Address;
  verifyOk: boolean;
  payerAccount: string;
  payerEvm: Address;
  operatorJobs: unknown[];
  bumps: unknown[];
  graphResult: unknown;
  graphThrows: boolean;
  consumeCalls: number;
};

function paymentHeader(quote: ReceiptQuote, salt = "tx-1"): string {
  const payload: PaymentPayload = {
    x402Version: 2,
    scheme: "exact",
    network: "hedera:testnet",
    payload: { transaction: `base64:${salt}` },
    accepted: {
      scheme: "exact",
      network: "hedera:testnet",
      asset: "0.0.0",
      maxAmountRequired: asset.manifest.paidAccess.price,
      payTo: "0.0.9999",
      resource: `/assets/${asset.assetId}/paid`,
      extra: {
        settlementMode: "custodial",
        value: asset.manifest.paidAccess.price,
        receiptQuote: quote,
      },
    },
  };
  return btoa(JSON.stringify(payload));
}

function receiptFromParams(p: ReceiptParamsJson): RightsReceipt {
  return {
    chainId: BigInt(CHAIN_ID),
    verifyingContract: RIGHTS_REGISTRY,
    nftContract: p.nftContract,
    tokenId: BigInt(p.tokenId),
    resourceHash: p.resourceHash,
    policyHash: p.policyHash,
    licenseEpoch: BigInt(p.licenseEpoch),
    ownerEpochAtIssue: BigInt(p.ownerEpochAtIssue),
    licensee: p.licensee,
    permittedAction: p.permittedAction,
    transferMode:
      p.transferMode === 1
        ? TransferMode.INVALIDATE_ON_TRANSFER
        : TransferMode.SURVIVE_TRANSFER,
    maxUses: p.maxUses,
    expiresAt: BigInt(p.expiresAt),
    purchaseRequestHash: p.purchaseRequestHash,
    paymentId: p.paymentId,
    nonce: p.nonce,
    issuedAt: BigInt(p.issuedAt),
  };
}

function buildServices(): Services {
  const deployment = {
    chainId: CHAIN_ID,
    rightsNFT: RIGHTS_NFT,
    rightsRegistry: RIGHTS_REGISTRY,
  };
  const resolveAsset = async (assetId: Hex) => {
    if (assetId.toLowerCase() !== asset.assetId.toLowerCase())
      throw new AssetNotFoundError(assetId);
    return {
      assetId: asset.assetId,
      tokenId: asset.tokenId,
      nftContract: RIGHTS_NFT,
      manifest: asset.manifest,
    };
  };
  const release: ReleasePorts = {
    env,
    db,
    deployment,
    chain: {
      ownerSnapshot: async () => ({
        owner: fake.tokenOwner,
        accessEpoch: fake.accessEpoch,
        policyHash: asset.policyHash,
        resourceHash: asset.resourceHash,
      }),
      tokenHashes: async () => ({
        policyHash: asset.policyHash,
        resourceHash: asset.resourceHash,
      }),
      receiptStatus: async () => ({
        issued: true,
        tokenId: asset.tokenId,
        licensee: buyer.address,
        maxUses: 5,
        usedCount: 0,
        expiresAt: BigInt(Math.floor(NOW.getTime() / 1000) + 300),
      }),
      hasValidConsumption: async () => true,
      getCode: async () => "0x",
    },
    resolveAsset,
    consume: async () => {
      fake.consumeCalls += 1;
      return {
        useIndex: 0,
        onchainTx: `0x${"77".repeat(32)}`,
        redelivered: false,
      };
    },
    now: () => NOW,
  };
  // the operator "mines" settleAndIssue: the tx hash encodes the params so receiptHashFromTx
  // can recompute exactly what the contract would have emitted
  const mined = new Map<string, Hex>();
  const settle: SettlePorts = {
    env,
    db,
    deployment,
    mode: "custodial",
    settlementAccountId: "0.0.9999",
    facilitator: {
      supported: async () => ({ kinds: [] }),
      verify: async () => ({
        isValid: fake.verifyOk,
        invalidReason: fake.verifyOk ? undefined : "bad",
        payer: fake.payerAccount,
      }),
      settle: async () => ({
        success: true,
        transaction: "0.0.4242@1700000000.000000001",
        network: "hedera:testnet",
        payer: fake.payerAccount,
      }),
    },
    resolveAsset,
    quoteReads: async () => ({
      licenseEpoch: fake.licenseEpoch,
      accessEpoch: fake.accessEpoch,
      policyHash: asset.policyHash,
      resourceHash: asset.resourceHash,
    }),
    operator: async (job) => {
      fake.operatorJobs.push(job);
      const txHash =
        `0x${fake.operatorJobs.length.toString(16).padStart(64, "0")}` as Hex;
      mined.set(txHash, computeReceiptHash(receiptFromParams(job.params)));
      return txHash;
    },
    receiptHashFromTx: async (txHash) => {
      const hash = mined.get(txHash);
      if (hash === undefined) throw new Error("unknown tx");
      return hash;
    },
    payerEvmAddress: async (accountId) =>
      accountId === fake.payerAccount ? fake.payerEvm : undefined,
    now: () => NOW,
    randomNonce: () => `0x${"51".repeat(32)}`,
  };
  const graph: GraphFetch = async () => {
    if (fake.graphThrows) throw new Error("boom");
    return fake.graphResult as never;
  };
  return {
    env,
    db,
    release,
    settle,
    graph,
    ipfsGateway: "https://ipfs.invalid",
    resolveAsset,
    fetchManifest: async () => asset.manifest,
    creatorOf: async () => fake.creator,
    licenseEpoch: async () => fake.licenseEpoch,
    bumpLicenseEpoch: async (input) => {
      fake.bumps.push(input);
      return `0x${"b1".repeat(32)}`;
    },
    waitForTx: async () => {},
    now: () => NOW,
  };
}

async function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function quoteFor(): Promise<ReceiptQuote> {
  const res = await app.request(`/assets/${asset.assetId}/paid`);
  const body = (await res.json()) as {
    accepts: Array<{ extra: { receiptQuote: ReceiptQuote } }>;
  };
  return body.accepts[0]?.extra.receiptQuote as ReceiptQuote;
}

beforeEach(async () => {
  ({ db, client } = await createTestDb());
  asset = buildAsset("a5");
  env = await makeEnv(new MemoryKv(), [asset]);
  fake = {
    licenseEpoch: 0n,
    accessEpoch: 1n,
    tokenOwner: owner.address,
    creator: creator.address,
    verifyOk: true,
    payerAccount: PAYER_ACCOUNT,
    payerEvm: buyer.address,
    operatorJobs: [],
    bumps: [],
    graphResult: { data: { rightsTokens: [] } },
    graphThrows: false,
    consumeCalls: 0,
  };
  const services = buildServices();
  app = new Hono<AppEnv>();
  app.onError(handleError);
  app.use("*", async (c, next) => {
    c.set("db", db);
    c.set("services", services);
    await next();
  });
  registerRoutes(app);
});

afterEach(async () => {
  await client.close();
});

describe("discovery (T086)", () => {
  it("should list assets from the subgraph with expanded manifests and redirect previews", async () => {
    fake.graphResult = {
      data: {
        rightsTokens: [
          {
            id: "1",
            assetId: asset.assetId,
            creator: creator.address,
            manifestURI: "ipfs://manifest-1",
            accessEpoch: "3",
            licenseEpoch: "1",
            owner: { id: owner.address },
          },
        ],
      },
    };
    const list = await app.request("/assets");
    expect(list.status).toBe(200);
    const items = (await list.json()) as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      assetId: asset.assetId,
      tokenId: "1",
      owner: owner.address,
      transferMode: "SURVIVE_TRANSFER",
      accessEpoch: 3,
      licenseEpoch: 1,
    });
    const preview = await app.request(`/assets/${asset.assetId}/preview`);
    expect(preview.status).toBe(302);
    expect(preview.headers.get("location")).toBe(
      "https://example.invalid/preview.png",
    );
    const missing = await app.request(`/assets/0x${"ee".repeat(32)}/preview`);
    expect(missing.status).toBe(404);
    expect((await app.request("/assets/not-hex/preview")).status).toBe(400);
  });
});

describe("owner path over HTTP (T087)", () => {
  it("should issue a challenge, accept the signed request and reject a replay", async () => {
    const challenge = await post("/owner/challenge", {
      assetId: asset.assetId,
      wallet: owner.address,
    });
    expect(challenge.status).toBe(200);
    const { typedData, nonce } = (await challenge.json()) as {
      typedData: Parameters<typeof owner.signTypedData>[0];
      nonce: Hex;
    };
    expect(nonce).toMatch(/^0x[0-9a-f]{64}$/);
    const authSig = await owner.signTypedData(typedData);
    const keyGateSig = await owner.signTypedData(
      keyGateTypedData(domain, {
        assetId: asset.assetId,
        purpose: "owner",
        receiptHash: ZERO32,
      }),
    );
    const ok = await post("/owner/keygate", {
      assetId: asset.assetId,
      wallet: owner.address,
      authSig,
      keyGateSig,
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as {
      shareG: Hex;
      ownerSession: { token: string };
    };
    expect(hexToBytes(body.shareG)).toEqual(asset.shareG);
    const replay = await post("/owner/keygate", {
      assetId: asset.assetId,
      wallet: owner.address,
      authSig,
      keyGateSig,
    });
    expect(replay.status).toBe(401);
    expect(await replay.json()).toMatchObject({
      code: "NONCE_INVALID_OR_EXPIRED",
    });
    const malformed = await post("/owner/keygate", {
      assetId: asset.assetId,
      wallet: "nope",
      authSig,
    });
    expect(malformed.status).toBe(400);
  });
});

describe("keygate share over HTTP (T089)", () => {
  it("should run the licensee path through the challenge + share endpoints", async () => {
    const RECEIPT = `0x${"d4".repeat(32)}` as Hex;
    const challenge = await post("/keygate/challenge", {
      receiptHash: RECEIPT,
      wallet: buyer.address,
    });
    const { typedData } = (await challenge.json()) as {
      typedData: Parameters<typeof buyer.signTypedData>[0];
    };
    const authSig = await buyer.signTypedData(typedData);
    const keyGateSig = await buyer.signTypedData(
      keyGateTypedData(domain, {
        assetId: asset.assetId,
        purpose: "licensee",
        receiptHash: RECEIPT,
      }),
    );
    const res = await post("/keygate/share", {
      path: "licensee",
      assetId: asset.assetId,
      receiptHash: RECEIPT,
      authSig,
      keyGateSig,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.path).toBe("licensee");
    expect(body.useIndex).toBe(0);
    expect(body.encryptedContentURI).toBe(asset.manifest.encryptedContentURI);
    expect(fake.consumeCalls).toBe(1);
  });
});

describe("x402 (T088 / T063)", () => {
  it("should answer 402 with hedera:testnet exact native HBAR requirements and the receipt quote", async () => {
    const res = await app.request(`/assets/${asset.assetId}/paid`);
    expect(res.status).toBe(402);
    const body = (await res.json()) as {
      x402Version: number;
      accepts: Array<Record<string, unknown>>;
      manifest: unknown;
    };
    expect(body.x402Version).toBe(2);
    expect(body.accepts[0]).toMatchObject({
      scheme: "exact",
      network: "hedera:testnet",
      asset: "0.0.0",
      maxAmountRequired: asset.manifest.paidAccess.price,
      payTo: "0.0.9999",
      resource: `/assets/${asset.assetId}/paid`,
    });
    const accept = body.accepts[0] as { extra: { receiptQuote: ReceiptQuote } };
    const quote = accept.extra.receiptQuote;
    expect(quote).toMatchObject({
      chainId: CHAIN_ID,
      tokenId: "1",
      policyHash: asset.policyHash,
      resourceHash: asset.resourceHash,
      licenseEpoch: "0",
      ownerEpochAtIssue: "1",
      maxUses: 5,
      priceTinybar: manifestToPolicyInput(
        asset.manifest,
      ).priceTinybar.toString(),
    });
    expect(quote.expiresAt - quote.issuedAt).toBe(300);
    expect(body.manifest).toMatchObject({ assetId: asset.assetId });
  });

  it("should settle on the custodial rail, bind the payment, and replay idempotently", async () => {
    const quote = await quoteFor();
    const header = paymentHeader(quote);
    const first = await post(
      `/assets/${asset.assetId}/paid`,
      { licensee: buyer.address },
      { "X-PAYMENT": header },
    );
    expect(first.status).toBe(200);
    const body = (await first.json()) as {
      receiptHash: Hex;
      receipt: Record<string, unknown>;
      serverSignature: string;
      settlementMode: string;
    };
    expect(body.settlementMode).toBe("custodial");
    expect(body.receipt.licensee).toBe(buyer.address);
    expect(fake.operatorJobs).toHaveLength(1);
    expect(fake.operatorJobs[0]).toMatchObject({
      kind: "settleAndIssue",
      valueWeibar: asset.manifest.paidAccess.price,
    });
    // same signed payload again: no second settlement, same receiptHash
    const replay = await post(
      `/assets/${asset.assetId}/paid`,
      { licensee: buyer.address },
      { "X-PAYMENT": header },
    );
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as { receiptHash: Hex }).receiptHash).toBe(
      body.receiptHash,
    );
    expect(fake.operatorJobs).toHaveLength(1);
  });

  it("should reject a payer / licensee mismatch, a facilitator rejection and a stale quote before anchoring", async () => {
    const quote = await quoteFor();
    fake.payerEvm = stranger.address;
    const mismatch = await post(
      `/assets/${asset.assetId}/paid`,
      { licensee: buyer.address },
      { "X-PAYMENT": paymentHeader(quote, "m1") },
    );
    expect(mismatch.status).toBe(403);
    expect(await mismatch.json()).toMatchObject({ code: "LICENSEE_MISMATCH" });
    fake.payerEvm = buyer.address;
    fake.verifyOk = false;
    const rejected = await post(
      `/assets/${asset.assetId}/paid`,
      { licensee: buyer.address },
      { "X-PAYMENT": paymentHeader(quote, "m2") },
    );
    expect(rejected.status).toBe(402);
    expect(await rejected.json()).toMatchObject({ code: "UNDERPAYMENT" });
    fake.verifyOk = true;
    fake.accessEpoch = 2n; // NFT transferred since the quote
    const stale = await post(
      `/assets/${asset.assetId}/paid`,
      { licensee: buyer.address },
      { "X-PAYMENT": paymentHeader(quote, "m3") },
    );
    expect(await stale.json()).toMatchObject({ code: "OWNER_EPOCH_MISMATCH" });
    expect(fake.operatorJobs).toHaveLength(0);
    const audit = (await (
      await app.request(`/audit?assetId=${asset.assetId}`)
    ).json()) as Array<{ outcome: string; code?: string }>;
    expect(audit.map((a) => a.code)).toEqual(
      expect.arrayContaining(["LICENSEE_MISMATCH", "UNDERPAYMENT"]),
    );
    expect(
      await (
        await post(`/assets/${asset.assetId}/paid`, { licensee: buyer.address })
      ).json(),
    ).toMatchObject({ code: "UNDERPAYMENT" });
  });
});

describe("graph + audit (T090)", () => {
  it("should pass GraphQL through and answer 502 when the subgraph is down", async () => {
    fake.graphResult = { data: { rightsTokens: [{ id: "1" }] } };
    const ok = await post("/graph", { query: "{ rightsTokens { id } }" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ data: { rightsTokens: [{ id: "1" }] } });
    fake.graphThrows = true;
    expect((await post("/graph", { query: "{ x }" })).status).toBe(502);
    expect((await post("/graph", { nope: 1 })).status).toBe(400);
  });

  it("should expose only allowlisted audit fields", async () => {
    const challenge = await post("/owner/challenge", {
      assetId: asset.assetId,
      wallet: owner.address,
    });
    const { typedData } = (await challenge.json()) as {
      typedData: Parameters<typeof owner.signTypedData>[0];
    };
    const authSig = await owner.signTypedData(typedData);
    await post("/owner/keygate", {
      assetId: asset.assetId,
      wallet: stranger.address,
      authSig,
    });
    const entries = (await (
      await app.request(`/audit?assetId=${asset.assetId}&limit=10`)
    ).json()) as Array<Record<string, unknown>>;
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(
        Object.keys(entry).every((k) =>
          [
            "id",
            "at",
            "action",
            "outcome",
            "code",
            "assetId",
            "subject",
            "onchainRef",
            "detail",
          ].includes(k),
        ),
      ).toBe(true);
      expect(JSON.stringify(entry)).not.toContain(authSig.slice(2, 20));
    }
    expect(entries[0]).toMatchObject({
      action: "owner_keygate",
      outcome: "deny",
    });
    expect((await app.request("/audit?limit=0")).status).toBe(400);
  });
});

describe("emergency revocation (T091)", () => {
  async function revocationSig(
    account: typeof creator,
    purpose: "bump-license-epoch" | "owner-access" = "bump-license-epoch",
  ): Promise<Hex> {
    const challenge = await post("/owner/challenge", {
      assetId: asset.assetId,
      wallet: account.address,
      purpose,
    });
    const { typedData } = (await challenge.json()) as {
      typedData: Parameters<typeof creator.signTypedData>[0];
    };
    return account.signTypedData(typedData);
  }

  it("should bump the license epoch for the creator's RevocationChallenge signature only", async () => {
    const forged = await post(`/assets/${asset.assetId}/bump-license-epoch`, {
      wallet: creator.address,
      revocationSig: await revocationSig(creator, "owner-access"), // access signature, wrong struct
    });
    expect(forged.status).toBe(401);
    expect(await forged.json()).toMatchObject({ code: "SIGNATURE_INVALID" });
    const notCreator = await post(
      `/assets/${asset.assetId}/bump-license-epoch`,
      {
        wallet: stranger.address,
        revocationSig: await revocationSig(stranger),
      },
    );
    expect(notCreator.status).toBe(403);
    expect(await notCreator.json()).toMatchObject({ code: "NOT_AUTHORIZED" });
    expect(fake.bumps).toHaveLength(0);
    const ok = await post(`/assets/${asset.assetId}/bump-license-epoch`, {
      wallet: creator.address,
      revocationSig: await revocationSig(creator),
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({
      tokenId: "1",
      newEpoch: 1,
      onchainTx: `0x${"b1".repeat(32)}`,
    });
    expect(fake.bumps[0]).toMatchObject({ tokenId: 1n, fromEpoch: 0n });
    expect(
      String((fake.bumps[0] as { idempotencyKey: string }).idempotencyKey),
    ).toMatch(/^bump:1:0x/);
  });
});
