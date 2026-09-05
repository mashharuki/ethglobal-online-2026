import { env } from "cloudflare:test";
import { keccak256, stringToHex } from "viem";
import { describe, expect, it } from "vitest";

/**
 * tasks.md T019 / research.md R-7 day1 probe: the runtime pieces the gateway depends on
 * must actually work inside workerd (this file runs under @cloudflare/vitest-pool-workers).
 * scripts/probe-workerd.ts turns the results into out/probe-workerd.json.
 * What each check proves is in its name; the Postgres round-trip needs a live database
 * (PROBE_DB_QUERY=1) and is reported as NOT probed otherwise. The MCP Streamable HTTP part
 * of T019 is exercised in the MCP PR (T093).
 */
describe("workerd runtime probe (T019)", () => {
  it("should run viem hashing in workerd", () => {
    expect(keccak256(stringToHex("abc"))).toBe(
      "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45",
    );
  });

  it("should load the postgres.js driver module in workerd (no connection)", async () => {
    const postgres = (await import("postgres")).default;
    expect(typeof postgres).toBe("function");
  });

  it("should expose the Hyperdrive binding with a connection string (binding only)", () => {
    expect(typeof env.HYPERDRIVE.connectionString).toBe("string");
    expect(env.HYPERDRIVE.connectionString.startsWith("postgres")).toBe(true);
  });

  it("should route to the ReceiptLock Durable Object per receiptHash", async () => {
    const id = env.RECEIPT_LOCK.idFromName(`0x${"01".repeat(32)}`);
    const response = await env.RECEIPT_LOCK.get(id).fetch("http://do/consume");
    expect(response.status).toBe(501);
    expect(await response.json()).toMatchObject({ code: "NOT_IMPLEMENTED" });
  });

  it("should route to the single OperatorTxQueue Durable Object", async () => {
    const id = env.OPERATOR_TX_QUEUE.idFromName("operator");
    const response = await env.OPERATOR_TX_QUEUE.get(id).fetch("http://do/tx");
    expect(response.status).toBe(501);
  });

  it("should read and write the SHARE_G KV namespace", async () => {
    await env.SHARE_G.put("probe", "ok");
    expect(await env.SHARE_G.get("probe", "text")).toBe("ok");
  });

  it("should run AES-256-GCM through Web Crypto in workerd", async () => {
    const key = (await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    )) as CryptoKey;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode("share"),
    );
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
    expect(new TextDecoder().decode(pt)).toBe("share");
  });

  it.skipIf(env.PROBE_DB_QUERY !== "1")(
    "should execute SELECT 1 through the Hyperdrive connection string (PROBE_DB_QUERY=1)",
    async () => {
      const postgres = (await import("postgres")).default;
      const sql = postgres(env.HYPERDRIVE.connectionString, {
        max: 1,
        fetch_types: false,
        prepare: false,
      });
      try {
        const rows = await sql`select 1 as one`;
        expect(rows[0]?.one).toBe(1);
      } finally {
        await sql.end({ timeout: 5 });
      }
    },
  );
});
