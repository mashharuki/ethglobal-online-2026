import type { PGlite } from "@electric-sql/pglite";
import {
  buildDomain,
  computePurchaseRequestHash,
  computeReceiptHash,
  keyGateTypedData,
  manifestToPolicyInput,
  type RightsReceipt,
  TransferMode,
} from "@truenft/shared";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { type Address, type Hex, hexToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type PaymentStage, paymentBinding } from "../../src/db/schema";
import type { Db } from "../../src/db/types";
import type { ReceiptParamsJson } from "../../src/do/operatorQueueCore";
import type { Env } from "../../src/env";
import { AppError, handleError } from "../../src/errors";
import type { GraphFetch } from "../../src/graph/cache";
import type { ReleasePorts } from "../../src/keygate/release";
import { AssetNotFoundError } from "../../src/manifest/resolver";
import { type AppEnv, registerRoutes } from "../../src/routes";
import type { Services } from "../../src/services";
import {
  derivePaymentId,
  PAID_ACCESS_PLAN_ID,
  type PaymentPayload,
} from "../../src/x402/facilitator";
import {
  type ReceiptQuote,
  type SettlePorts,
  takeClaim,
} from "../../src/x402/settle";
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
let services: Services;

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
  mode: "primary" | "fallback" | "custodial";
  settlementAccountId: string;
  settleCalls: number;
  /** operator rejects with the ReceiptAlreadyIssued mapping (retry after broadcast crash) */
  operatorConflict: boolean;
  /** receipt hashes RightsRegistry.receiptStatus(hash).issued answers true for */
  issuedOnChain: Set<Hex>;
  /** the "mined" tx emits a foreign receipt instead of ours */
  minesWrongHash: boolean;
  /** facilitator /settle: throws (outcome unknown), throws an AppError, or answers success=false */
  settleThrows: boolean;
  settleThrowsAppError: boolean;
  settleRejects: boolean;
  settleDelayMs: number;
  /** the receipt wait (tx confirmation) blows up */
  receiptWaitThrows: boolean;
  /** injected clock (lease expiry) */
  now: Date;
  /** when set, the next facilitator /verify awaits it before answering */
  verifyGate?: Promise<void>;
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
    now: () => fake.now,
  };
  // the operator "mines" settleAndIssue: the tx hash encodes the params so receiptHashFromTx
  // can recompute exactly what the contract would have emitted
  const mined = new Map<string, Hex>();
  const settle: SettlePorts = {
    env,
    db,
    deployment,
    get mode() {
      return fake.mode;
    },
    get settlementAccountId() {
      return fake.settlementAccountId;
    },
    facilitator: {
      supported: async () => ({ kinds: [] }),
      verify: async () => {
        // one-shot barrier so a test can park a request inside its claim
        const gate = fake.verifyGate;
        fake.verifyGate = undefined;
        if (gate !== undefined) await gate;
        return {
          isValid: fake.verifyOk,
          invalidReason: fake.verifyOk ? undefined : "bad",
          payer: fake.payerAccount === "" ? undefined : fake.payerAccount,
        };
      },
      settle: async () => {
        fake.settleCalls += 1;
        if (fake.settleDelayMs > 0) {
          await new Promise((r) => setTimeout(r, fake.settleDelayMs));
        }
        if (fake.settleThrows) throw new Error("facilitator timeout");
        if (fake.settleThrowsAppError) {
          throw new AppError(
            "UNDERPAYMENT",
            "facilitator answered 402 mid-flight",
          );
        }
        return {
          success: !fake.settleRejects,
          errorReason: fake.settleRejects ? "insufficient" : undefined,
          transaction: "0.0.4242@1700000000.000000001",
          network: "hedera:testnet",
          payer: fake.payerAccount,
        };
      },
    },
    resolveAsset,
    quoteReads: async () => ({
      licenseEpoch: fake.licenseEpoch,
      accessEpoch: fake.accessEpoch,
      policyHash: asset.policyHash,
      resourceHash: asset.resourceHash,
    }),
    operator: async (job) => {
      if (fake.operatorConflict) {
        throw new AppError(
          "PAYMENT_ID_PAYLOAD_CONFLICT",
          "ReceiptAlreadyIssued",
        );
      }
      fake.operatorJobs.push(job);
      const txHash =
        `0x${fake.operatorJobs.length.toString(16).padStart(64, "0")}` as Hex;
      mined.set(
        txHash,
        fake.minesWrongHash
          ? (`0x${"f0".repeat(32)}` as Hex)
          : computeReceiptHash(receiptFromParams(job.params)),
      );
      return txHash;
    },
    receiptHashesFromTx: async (txHash) => {
      if (fake.receiptWaitThrows) throw new Error("receipt wait timed out");
      const hash = mined.get(txHash);
      if (hash === undefined) throw new Error("unknown tx");
      return [hash];
    },
    receiptIssued: async (hash) => fake.issuedOnChain.has(hash),
    pendingWaitMs: 20,
    payerEvmAddress: async (accountId) =>
      accountId === fake.payerAccount ? fake.payerEvm : undefined,
    now: () => fake.now,
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
    now: () => fake.now,
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

/** what the gateway will anchor for this payload: receipt = f(quote, licensee, paymentId) */
function expectedReceiptHash(
  quote: ReceiptQuote,
  header: string,
  licensee: Address,
): Hex {
  return computeReceiptHash({
    chainId: BigInt(quote.chainId),
    verifyingContract: quote.verifyingContract,
    nftContract: quote.nftContract,
    tokenId: BigInt(quote.tokenId),
    resourceHash: quote.resourceHash,
    policyHash: quote.policyHash,
    licenseEpoch: BigInt(quote.licenseEpoch),
    ownerEpochAtIssue: BigInt(quote.ownerEpochAtIssue),
    licensee,
    permittedAction: quote.permittedAction,
    transferMode:
      quote.transferMode === 1
        ? TransferMode.INVALIDATE_ON_TRANSFER
        : TransferMode.SURVIVE_TRANSFER,
    maxUses: quote.maxUses,
    expiresAt: BigInt(quote.expiresAt),
    purchaseRequestHash: computePurchaseRequestHash({
      httpMethod: "POST",
      path: `/assets/${asset.assetId}/paid`,
      planId: PAID_ACCESS_PLAN_ID,
      resourceHash: quote.resourceHash,
      policyHash: quote.policyHash,
    }),
    paymentId: derivePaymentId(new TextEncoder().encode(atob(header))),
    nonce: quote.nonce,
    issuedAt: BigInt(quote.issuedAt),
  });
}

type BindingView = {
  status: string;
  stage: string;
  paid: boolean;
  claimed: boolean;
};

async function binding(header: string): Promise<BindingView | undefined> {
  const paymentId = derivePaymentId(new TextEncoder().encode(atob(header)));
  const [row] = await db
    .select()
    .from(paymentBinding)
    .where(eq(paymentBinding.paymentId, paymentId));
  if (row === undefined) return undefined;
  return {
    status: row.status,
    stage: row.stage,
    paid: row.paidAt !== null,
    claimed: row.claimToken !== null,
  };
}

/** a binding row as an earlier (dead) request would have left it */
async function seedBinding(
  header: string,
  quote: ReceiptQuote,
  row: { stage: PaymentStage; claimedAt: Date; paidAt?: Date },
): Promise<void> {
  await db.insert(paymentBinding).values({
    paymentId: derivePaymentId(new TextEncoder().encode(atob(header))),
    purchaseRequestHash: computePurchaseRequestHash({
      httpMethod: "POST",
      path: `/assets/${asset.assetId}/paid`,
      planId: PAID_ACCESS_PLAN_ID,
      resourceHash: quote.resourceHash,
      policyHash: quote.policyHash,
    }),
    amount: BigInt(quote.priceTinybar),
    status: "pending",
    stage: row.stage,
    claimToken: `0x${"dd".repeat(16)}`,
    claimedAt: row.claimedAt,
    paidAt: row.paidAt,
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
    mode: "custodial",
    settlementAccountId: "0.0.9999",
    settleCalls: 0,
    operatorConflict: false,
    issuedOnChain: new Set(),
    minesWrongHash: false,
    settleThrows: false,
    settleThrowsAppError: false,
    settleRejects: false,
    settleDelayMs: 0,
    receiptWaitThrows: false,
    now: NOW,
  };
  services = buildServices();
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
    expect(quote.nonce).toBe(`0x${"51".repeat(32)}`);
    expect(body.manifest).toMatchObject({ assetId: asset.assetId });
  });

  it("should refuse to quote on the custodial rail without a settlement account", async () => {
    fake.settlementAccountId = "";
    const res = await app.request(`/assets/${asset.assetId}/paid`);
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "internal_error" });
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
    const replayed = (await replay.json()) as {
      receiptHash: Hex;
      receipt: Record<string, unknown>;
      serverSignature: string;
    };
    expect(replayed.receiptHash).toBe(body.receiptHash);
    expect(replayed.receipt).toEqual(body.receipt);
    expect(replayed.serverSignature).toBe(body.serverSignature);
    expect(fake.operatorJobs).toHaveLength(1);
    expect(fake.settleCalls).toBe(1);
    // same payload, different licensee: not a replay of this purchase
    const other = await post(
      `/assets/${asset.assetId}/paid`,
      { licensee: stranger.address },
      { "X-PAYMENT": header },
    );
    expect(other.status).toBe(409);
    expect(await other.json()).toMatchObject({
      code: "PAYMENT_ID_PAYLOAD_CONFLICT",
    });
    expect(fake.settleCalls).toBe(1);
  });

  it("should keep a paid binding resumable and recover only the exact receipt from the registry", async () => {
    const quote = await quoteFor();
    const header = paymentHeader(quote, "dup");
    const ours = expectedReceiptHash(quote, header, buyer.address);
    const pay = () =>
      post(
        `/assets/${asset.assetId}/paid`,
        { licensee: buyer.address },
        { "X-PAYMENT": header },
      );
    // 1. the operator refuses (ReceiptAlreadyIssued) but the registry has no such receipt
    fake.operatorConflict = true;
    const stuck = await pay();
    expect(stuck.status).toBe(409);
    expect(await stuck.json()).toMatchObject({
      code: "PAYMENT_ID_PAYLOAD_CONFLICT",
    });
    expect(await binding(header)).toEqual({
      status: "pending",
      stage: "anchor",
      paid: true,
      claimed: false,
    });
    expect(fake.settleCalls).toBe(1);
    // 2. some other receipt being issued does not count
    fake.issuedOnChain.add(`0x${"f0".repeat(32)}`);
    expect((await pay()).status).toBe(409);
    expect(fake.settleCalls).toBe(1); // resumed at anchoring, never paid again
    // 3. the receipt wait blows up but issuance became visible meanwhile: recovered in-flight
    fake.operatorConflict = false;
    fake.receiptWaitThrows = true;
    fake.issuedOnChain.add(ours);
    const recovered = await pay();
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({
      receiptHash: ours,
      onchainTx: "already-issued",
    });
    expect(await binding(header)).toMatchObject({
      status: "settled",
      stage: "done",
      claimed: false,
    });
    expect(fake.settleCalls).toBe(1);
    fake.receiptWaitThrows = false;
    // 4. a fresh payment whose tx issued a foreign receipt is a params mismatch, still paid
    fake.operatorConflict = false;
    fake.minesWrongHash = true;
    const other = paymentHeader(quote, "foreign");
    const foreign = await post(
      `/assets/${asset.assetId}/paid`,
      { licensee: buyer.address },
      { "X-PAYMENT": other },
    );
    expect(foreign.status).toBe(409);
    expect(await foreign.json()).toMatchObject({
      code: "COMMITTED_PARAMS_MISMATCH",
    });
    expect(await binding(other)).toMatchObject({ stage: "anchor", paid: true });
    // ... and resumes to success once the operator anchors the right receipt
    fake.minesWrongHash = false;
    const resumed = await post(
      `/assets/${asset.assetId}/paid`,
      { licensee: buyer.address },
      { "X-PAYMENT": other },
    );
    expect(resumed.status).toBe(200);
    expect(fake.settleCalls).toBe(2);
    expect(fake.operatorJobs).toHaveLength(2);
  });

  it("should map settlement stages onto the binding: rejected -> failed, unknown -> pending", async () => {
    const quote = await quoteFor();
    const header = paymentHeader(quote, "stages");
    const pay = () =>
      post(
        `/assets/${asset.assetId}/paid`,
        { licensee: buyer.address },
        { "X-PAYMENT": header },
      );
    fake.settleRejects = true;
    const rejected = await pay();
    expect(rejected.status).toBe(402);
    expect(await binding(header)).toEqual({
      status: "failed",
      stage: "verify",
      paid: false,
      claimed: false,
    });
    fake.settleRejects = false;
    fake.settleThrows = true;
    const unknown = await pay();
    expect(unknown.status).toBe(500);
    expect(await binding(header)).toEqual({
      status: "pending",
      stage: "settle",
      paid: false,
      claimed: false,
    });
    expect(fake.settleCalls).toBe(2);
    fake.settleThrows = false;
    // the outcome is unknown: nobody re-submits the payment
    const blocked = await pay();
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({
      code: "SETTLEMENT_IN_PROGRESS",
    });
    expect(fake.settleCalls).toBe(2);
    expect(fake.operatorJobs).toHaveLength(0);
  });

  it("should treat an AppError thrown mid-settlement as unknown, not as a rejection", async () => {
    const quote = await quoteFor();
    const header = paymentHeader(quote, "midflight");
    fake.settleThrowsAppError = true;
    const res = await post(
      `/assets/${asset.assetId}/paid`,
      { licensee: buyer.address },
      { "X-PAYMENT": header },
    );
    expect(res.status).toBe(402);
    expect(await binding(header)).toMatchObject({
      status: "pending",
      stage: "settle",
    });
    fake.settleThrowsAppError = false;
    const retry = await post(
      `/assets/${asset.assetId}/paid`,
      { licensee: buyer.address },
      { "X-PAYMENT": header },
    );
    expect(await retry.json()).toMatchObject({
      code: "SETTLEMENT_IN_PROGRESS",
    });
    expect(fake.settleCalls).toBe(1);
  });

  it("should let exactly one of two concurrent identical payments settle", async () => {
    const quote = await quoteFor();
    const header = paymentHeader(quote, "race");
    fake.settleDelayMs = 60; // longer than the replay wait budget (pendingWaitMs)
    const pay = () =>
      post(
        `/assets/${asset.assetId}/paid`,
        { licensee: buyer.address },
        { "X-PAYMENT": header },
      );
    const [a, b] = await Promise.all([pay(), pay()]);
    // the second request either gives up on the live claim or, if scheduling let the first
    // finish inside its wait budget, replays; it never pays
    for (const res of [a, b]) {
      expect([200, 409]).toContain(res.status);
      if (res.status === 409) {
        expect(await res.json()).toMatchObject({
          code: "SETTLEMENT_IN_PROGRESS",
        });
      }
    }
    expect(fake.settleCalls).toBe(1);
    expect(fake.operatorJobs).toHaveLength(1);
    fake.settleDelayMs = 0;
    const replay = await pay();
    expect(replay.status).toBe(200);
    expect(fake.settleCalls).toBe(1);
  });

  it("should take over an expired claim by its stage and refuse a stale takeover", async () => {
    const quote = await quoteFor();
    const pay = (header: string) =>
      post(
        `/assets/${asset.assetId}/paid`,
        { licensee: buyer.address },
        { "X-PAYMENT": header },
      );
    const expired = new Date(NOW.getTime() - 10 * 60_000);
    // a holder that died during verify: nothing moved, taken over and paid once
    const verify = paymentHeader(quote, "dead-verify");
    await seedBinding(verify, quote, { stage: "verify", claimedAt: expired });
    expect((await pay(verify)).status).toBe(200);
    expect(fake.settleCalls).toBe(1);
    // a holder that died while /settle was in flight: blocked, never re-submitted
    const settle = paymentHeader(quote, "dead-settle");
    await seedBinding(settle, quote, { stage: "settle", claimedAt: expired });
    expect(await (await pay(settle)).json()).toMatchObject({
      code: "SETTLEMENT_IN_PROGRESS",
    });
    expect(fake.settleCalls).toBe(1);
    // a holder that died after paying: resumed at anchoring without paying again
    const anchor = paymentHeader(quote, "dead-anchor");
    await seedBinding(anchor, quote, {
      stage: "anchor",
      claimedAt: expired,
      paidAt: expired,
    });
    expect((await pay(anchor)).status).toBe(200);
    expect(fake.settleCalls).toBe(1);
    expect(fake.operatorJobs).toHaveLength(2);
    // a stale takeover: the taker observed (verify, expired) but the holder advanced the
    // stage before the CAS -> production takeClaim refuses, the row is untouched
    const moved = paymentHeader(quote, "moved-on");
    await seedBinding(moved, quote, { stage: "verify", claimedAt: expired });
    const paymentId = derivePaymentId(new TextEncoder().encode(atob(moved)));
    const rowOf = async () => {
      const [row] = await db
        .select()
        .from(paymentBinding)
        .where(eq(paymentBinding.paymentId, paymentId));
      if (row === undefined) throw new Error("seed missing");
      return row;
    };
    const observed = await rowOf();
    await db
      .update(paymentBinding)
      .set({ stage: "settle" })
      .where(eq(paymentBinding.paymentId, paymentId));
    const taken = await takeClaim(
      services.settle,
      observed,
      `0x${"ee".repeat(16)}`,
    );
    expect(taken).toBeUndefined();
    expect(await rowOf()).toMatchObject({
      stage: "settle",
      claimToken: observed.claimToken,
      claimedAt: observed.claimedAt,
    });
    // and the same observation with only the lease refreshed is stale too
    await db
      .update(paymentBinding)
      .set({ stage: "verify", claimedAt: NOW })
      .where(eq(paymentBinding.paymentId, paymentId));
    expect(
      await takeClaim(services.settle, observed, `0x${"ef".repeat(16)}`),
    ).toBeUndefined();
    expect((await rowOf()).claimToken).toBe(observed.claimToken);
    expect(fake.settleCalls).toBe(1);
  });

  it("should make a holder whose lease was taken over lose its claim instead of paying", async () => {
    const quote = await quoteFor();
    const header = paymentHeader(quote, "takeover");
    const pay = () =>
      post(
        `/assets/${asset.assetId}/paid`,
        { licensee: buyer.address },
        { "X-PAYMENT": header },
      );
    let release: () => void = () => {};
    fake.verifyGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = pay(); // claims, then parks inside /verify
    await new Promise((r) => setTimeout(r, 10));
    expect(await binding(header)).toMatchObject({
      stage: "verify",
      claimed: true,
    });
    // its lease expires (clock jump) and a retry takes the row over and settles
    fake.now = new Date(NOW.getTime() + 10 * 60_000);
    const taker = await pay();
    expect(taker.status).toBe(200);
    expect(fake.settleCalls).toBe(1);
    // the original holder wakes up: its stage write is refused, it never reaches /settle
    release();
    const lost = await holder;
    expect(lost.status).toBe(409);
    expect(await lost.json()).toMatchObject({ code: "SETTLEMENT_IN_PROGRESS" });
    expect(fake.settleCalls).toBe(1);
    expect(await binding(header)).toMatchObject({
      status: "settled",
      stage: "done",
      claimed: false,
    });
  });

  it("should resume a primary-rail payment only once the facilitator tx is visible", async () => {
    fake.mode = "primary";
    const quote = await quoteFor();
    const header = paymentHeader(quote, "primary");
    const ours = expectedReceiptHash(quote, header, buyer.address);
    const pay = () =>
      post(
        `/assets/${asset.assetId}/paid`,
        { licensee: buyer.address },
        { "X-PAYMENT": header },
      );
    fake.receiptWaitThrows = true;
    expect((await pay()).status).toBe(500);
    expect(await binding(header)).toMatchObject({
      status: "pending",
      stage: "anchor",
      paid: true,
      claimed: false,
    });
    // paid but not visible yet: no second payment, no operator involvement
    const notYet = await pay();
    expect(await notYet.json()).toMatchObject({
      code: "SETTLEMENT_IN_PROGRESS",
    });
    expect(fake.settleCalls).toBe(1);
    fake.issuedOnChain.add(ours);
    const done = await pay();
    expect(done.status).toBe(200);
    expect(await done.json()).toMatchObject({
      receiptHash: ours,
      onchainTx: "already-issued",
      settlementMode: "primary",
    });
    expect(fake.settleCalls).toBe(1);
    expect(fake.operatorJobs).toHaveLength(0);
  });

  it("should reject a payer / licensee mismatch, a facilitator rejection and a stale quote before anchoring", async () => {
    const quote = await quoteFor();
    fake.payerAccount = ""; // facilitator reports no payer: fail closed
    const noPayer = await post(
      `/assets/${asset.assetId}/paid`,
      { licensee: buyer.address },
      { "X-PAYMENT": paymentHeader(quote, "m0") },
    );
    expect(noPayer.status).toBe(403);
    expect(await noPayer.json()).toMatchObject({ code: "LICENSEE_MISMATCH" });
    fake.payerAccount = PAYER_ACCOUNT;
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

  it("should finalize on the fallback rail only for the receipt the quote determines", async () => {
    fake.mode = "fallback";
    const quote = await quoteFor();
    const paymentId = `0x${"9a".repeat(32)}` as Hex;
    const paid = await post(
      `/assets/${asset.assetId}/paid`,
      { licensee: buyer.address },
      { "X-PAYMENT": paymentHeader(quote) },
    );
    expect(await paid.json()).toMatchObject({
      code: "SETTLEMENT_NOT_FINALIZED",
    });
    const { nonce, priceTinybar, creatorBps, ownerBps, ...terms } = quote;
    const receipt = {
      ...terms,
      licensee: buyer.address,
      purchaseRequestHash: computePurchaseRequestHash({
        httpMethod: "POST",
        path: `/assets/${asset.assetId}/paid`,
        planId: PAID_ACCESS_PLAN_ID,
        resourceHash: quote.resourceHash,
        policyHash: quote.policyHash,
      }),
      paymentId,
      nonce,
    };
    const body = {
      paymentId,
      receipt,
      price: priceTinybar,
      creatorBps,
      ownerBps,
    };
    // terms that feed the quote are caught by the chain re-check ...
    const badTerms = await post(`/assets/${asset.assetId}/finalize`, {
      ...body,
      receipt: { ...receipt, maxUses: 999 },
    });
    expect(badTerms.status).toBe(403);
    expect(await badTerms.json()).toMatchObject({
      code: "POLICY_HASH_MISMATCH",
    });
    // ... everything else by the receipt-hash comparison
    const tampered = await post(`/assets/${asset.assetId}/finalize`, {
      ...body,
      receipt: { ...receipt, purchaseRequestHash: `0x${"ab".repeat(32)}` },
    });
    expect(tampered.status).toBe(409);
    expect(await tampered.json()).toMatchObject({
      code: "COMMITTED_PARAMS_MISMATCH",
    });
    const wrongPayment = await post(`/assets/${asset.assetId}/finalize`, {
      ...body,
      paymentId: `0x${"9b".repeat(32)}`,
    });
    expect(wrongPayment.status).toBe(409);
    expect(fake.operatorJobs).toHaveLength(0);
    const ok = await post(`/assets/${asset.assetId}/finalize`, body);
    expect(ok.status).toBe(200);
    const issued = (await ok.json()) as { receiptHash: Hex };
    expect(issued).toMatchObject({
      settlementMode: "fallback",
      receipt: { paymentId, nonce, licensee: buyer.address },
    });
    expect(fake.operatorJobs[0]).toMatchObject({ kind: "finalize", paymentId });
    // already anchored: handed out again even after the NFT moved (no fresh issuance needed)
    fake.issuedOnChain.add(issued.receiptHash);
    fake.accessEpoch = 2n;
    const again = await post(`/assets/${asset.assetId}/finalize`, body);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({
      receiptHash: issued.receiptHash,
      onchainTx: "already-issued",
    });
    expect(fake.operatorJobs).toHaveLength(1);
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
