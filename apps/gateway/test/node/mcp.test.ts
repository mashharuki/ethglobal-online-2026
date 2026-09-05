import type { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Hono } from "hono";
import { type Hex, keccak256 } from "viem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/types";
import type { Env } from "../../src/env";
import { handleError } from "../../src/errors";
import { verifySessionId } from "../../src/mcp/session";
import { type AppEnv, registerRoutes } from "../../src/routes";
import type { Services } from "../../src/services";
import { parseSpendCap } from "../../src/services";
import { buildServices, createFake, type Fake, NOW } from "./fakeServices";
import {
  buildAsset,
  createTestDb,
  MemoryKv,
  makeEnv,
  type TestAsset,
} from "./helpers";

/**
 * MCP tests (tasks.md T092-T096, quickstart SC-011): a real MCP client over the Streamable
 * HTTP transport, routed in-memory into the gateway app. Chain / facilitator are the shared
 * fakes; the agent wallet is a local key standing in for the Privy server wallet (the Privy
 * RPC itself is credential-gated: BLOCKED until PRIVY_* are set).
 */
const PLAINTEXT =
  "region,segment,mrr_usd,churn_pct\nEU,smb,1200,3.1\nUS,ent,9800,1.2\n";

let db: Db;
let client: PGlite;
let env: Env;
let asset: TestAsset;
let app: Hono<AppEnv>;
let fake: Fake;
let services: Services;

async function encryptWithKey(
  key: Uint8Array,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key.slice(),
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      cryptoKey,
      plaintext.slice(),
    ),
  );
  const blob = new Uint8Array(12 + ciphertext.length);
  blob.set(iv, 0);
  blob.set(ciphertext, 12);
  return blob;
}

async function connect(): Promise<Client> {
  return (await connectWithTransport()).mcp;
}

async function connectWithTransport(): Promise<{
  mcp: Client;
  transport: StreamableHTTPClientTransport;
}> {
  const transport = new StreamableHTTPClientTransport(
    new URL("http://gateway.test/mcp"),
    {
      fetch: async (url, init) => app.request(String(url), init as RequestInit),
    },
  );
  const mcp = new Client({ name: "mcp-test", version: "0.0.0" });
  await mcp.connect(transport);
  return { mcp, transport };
}

async function rawToolCall(
  name: string,
  args: Record<string, unknown>,
  sessionId?: string,
): Promise<Record<string, unknown>> {
  const res = await app.request("http://gateway.test/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    result: { isError?: boolean; content: Array<{ text: string }> };
  };
  expect(body.result.isError).toBe(true);
  return JSON.parse(body.result.content[0]?.text ?? "{}") as Record<
    string,
    unknown
  >;
}

type ToolAnswer = { isError: boolean; body: Record<string, unknown> };

async function call(
  mcp: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolAnswer> {
  const result = (await mcp.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ type: string; text?: string }>;
  };
  const text = result.content.find((c) => c.type === "text")?.text ?? "{}";
  return {
    isError: result.isError === true,
    body: JSON.parse(text) as Record<string, unknown>,
  };
}

beforeEach(async () => {
  ({ db, client } = await createTestDb());
  const key = buildAsset("a5").contentKey;
  const blob = await encryptWithKey(key, new TextEncoder().encode(PLAINTEXT));
  asset = buildAsset("a5", { contentHash: keccak256(blob) });
  env = await makeEnv(new MemoryKv(), [asset]);
  fake = createFake();
  fake.contentBlob = blob;
  services = buildServices({ db, env, asset, fake });
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

describe("MCP server (T096)", () => {
  it("should expose the three tools and mint a server-signed session id on initialize", async () => {
    const { mcp, transport } = await connectWithTransport();
    const sessionId = transport.sessionId;
    expect(sessionId).toBeDefined();
    expect(await verifySessionId(env, sessionId, NOW)).toBe(sessionId);
    const tools = (await mcp.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(["buy_access", "decrypt_content", "discover_assets"]);
    const discovered = await call(mcp, "discover_assets", {});
    expect(discovered.isError).toBe(false);
    await mcp.close();
  });

  it("should refuse tools/call without a session, with a forged id and with an expired id", async () => {
    expect(
      await rawToolCall("buy_access", { assetId: asset.assetId }),
    ).toMatchObject({ code: "MCP_SESSION_MISMATCH" });
    expect(
      await rawToolCall(
        "buy_access",
        { assetId: asset.assetId },
        crypto.randomUUID(),
      ),
    ).toMatchObject({ code: "MCP_SESSION_MISMATCH" });
    const { transport } = await connectWithTransport();
    const real = transport.sessionId as string;
    fake.now = new Date(NOW.getTime() + 25 * 60 * 60 * 1000); // past the 24 h lifetime
    expect(
      await rawToolCall("buy_access", { assetId: asset.assetId }, real),
    ).toMatchObject({ code: "MCP_SESSION_MISMATCH" });
    expect(fake.settleCalls).toBe(0);
    expect(fake.signCalls).toBe(0);
  });
});

describe("buy_access -> decrypt_content (T094 / T095, R-9a)", () => {
  it("should buy with the agent wallet, bind the receipt to the session and decrypt only from it", async () => {
    const mcp = await connect();
    const bought = await call(mcp, "buy_access", { assetId: asset.assetId });
    expect(bought.isError).toBe(false);
    expect(bought.body).toMatchObject({ maxUses: 5 });
    const receiptHash = bought.body.receiptHash as Hex;
    expect(receiptHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(fake.settleCalls).toBe(1);
    expect(fake.operatorJobs).toHaveLength(1);
    // the agent (buyer key) is the licensee of the anchored receipt
    expect(
      (fake.operatorJobs[0] as { params: { licensee: string } }).params
        .licensee,
    ).toBe(fake.agentWallet.address);

    const decrypted = await call(mcp, "decrypt_content", {
      assetId: asset.assetId,
      receiptHash,
    });
    expect(decrypted.isError).toBe(false);
    expect(decrypted.body).toMatchObject({
      useIndex: 0,
      dataset: { format: "csv", content: PLAINTEXT },
    });
    expect(fake.consumeCalls).toBe(1);

    // another MCP session that learned the receiptHash (it is public on chain) is refused
    const other = await connect();
    const stolen = await call(other, "decrypt_content", {
      assetId: asset.assetId,
      receiptHash,
    });
    expect(stolen.isError).toBe(true);
    expect(stolen.body).toMatchObject({ code: "MCP_SESSION_MISMATCH" });
    expect(fake.consumeCalls).toBe(1);
    await other.close();
    await mcp.close();
  });

  it("should refuse to decrypt content whose ciphertext does not match the manifest", async () => {
    const mcp = await connect();
    const bought = await call(mcp, "buy_access", { assetId: asset.assetId });
    fake.contentBlob = new Uint8Array([1, 2, 3]);
    const decrypted = await call(mcp, "decrypt_content", {
      assetId: asset.assetId,
      receiptHash: bought.body.receiptHash as Hex,
    });
    expect(decrypted.isError).toBe(true);
    expect(decrypted.body).toMatchObject({ code: "CONTENT_HASH_MISMATCH" });
    await mcp.close();
  });
});

describe("spend policy (T092, SC-011 positive control)", () => {
  it("should reject a purchase over the per-session cap before signing anything", async () => {
    const mcp = await connect();
    const price = 500_000_000n; // 5 HBAR in tinybar (manifest price 5e18 weibar)
    fake.spendCap = price - 1n;
    const refused = await call(mcp, "buy_access", { assetId: asset.assetId });
    expect(refused.isError).toBe(true);
    expect(refused.body).toMatchObject({ code: "SPEND_LIMIT_EXCEEDED" });
    expect(fake.signCalls).toBe(0); // refused before the wallet was asked for anything
    expect(fake.settleCalls).toBe(0);
    expect(fake.operatorJobs).toHaveLength(0);
    // exactly the cap: allowed once, then the session is spent
    fake.spendCap = price;
    const first = await call(mcp, "buy_access", { assetId: asset.assetId });
    expect(first.isError).toBe(false);
    expect(fake.signCalls).toBeGreaterThan(0);
    expect(fake.settleCalls).toBe(1);
    const signed = fake.signCalls;
    const second = await call(mcp, "buy_access", { assetId: asset.assetId });
    expect(second.isError).toBe(true);
    expect(second.body).toMatchObject({ code: "SPEND_LIMIT_EXCEEDED" });
    expect(fake.signCalls).toBe(signed);
    expect(fake.settleCalls).toBe(1);
    // a fresh session has its own budget
    const other = await connect();
    const third = await call(other, "buy_access", { assetId: asset.assetId });
    expect(third.isError).toBe(false);
    expect(fake.settleCalls).toBe(2);
    await other.close();
    await mcp.close();
  });

  it("should let exactly one of two concurrent purchases through the cap", async () => {
    const mcp = await connect();
    fake.spendCap = 500_000_000n; // one purchase
    fake.settleDelayMs = 30;
    const [a, b] = await Promise.all([
      call(mcp, "buy_access", { assetId: asset.assetId }),
      call(mcp, "buy_access", { assetId: asset.assetId }),
    ]);
    const outcomes = [a, b].map((r) => r.isError).sort();
    expect(outcomes).toEqual([false, true]);
    const loser = a.isError ? a : b;
    expect(loser.body).toMatchObject({ code: "SPEND_LIMIT_EXCEEDED" });
    expect(fake.settleCalls).toBe(1);
    expect(fake.operatorJobs).toHaveLength(1);
    await mcp.close();
  });

  it("should keep the reservation when the outcome is unknown and give it back on a rejection", async () => {
    const mcp = await connect();
    const price = 500_000_000n;
    fake.spendCap = 2n * price - 1n; // room for one purchase plus a partial second
    fake.settleThrows = true; // facilitator outcome unknown: budget stays reserved
    const unknown = await call(mcp, "buy_access", { assetId: asset.assetId });
    expect(unknown.isError).toBe(true);
    fake.settleThrows = false;
    const blocked = await call(mcp, "buy_access", { assetId: asset.assetId });
    expect(blocked.body).toMatchObject({ code: "SPEND_LIMIT_EXCEEDED" });
    expect(fake.settleCalls).toBe(1);
    // a fresh session: a definitive facilitator rejection releases the reservation
    const other = await connect();
    fake.verifyOk = false;
    const rejected = await call(other, "buy_access", {
      assetId: asset.assetId,
    });
    expect(rejected.body).toMatchObject({ code: "UNDERPAYMENT" });
    fake.verifyOk = true;
    const retried = await call(other, "buy_access", { assetId: asset.assetId });
    expect(retried.isError).toBe(false);
    await other.close();
    await mcp.close();
  });

  it("should treat an unset or malformed cap as zero", () => {
    expect(parseSpendCap(undefined)).toBe(0n);
    expect(parseSpendCap("")).toBe(0n);
    expect(parseSpendCap("12x")).toBe(0n);
    expect(parseSpendCap("-5")).toBe(0n);
    expect(parseSpendCap("2000000000")).toBe(2_000_000_000n);
  });

  it("should fail closed when the facilitator advertises no fee payer", async () => {
    const mcp = await connect();
    fake.feePayer = "";
    const refused = await call(mcp, "buy_access", { assetId: asset.assetId });
    expect(refused.isError).toBe(true);
    expect(refused.body).toMatchObject({ code: "FACILITATOR_UNAVAILABLE" });
    expect(fake.settleCalls).toBe(0);
    await mcp.close();
  });
});
