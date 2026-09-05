import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("GET /healthz", () => {
  it("should report ok with the Hedera testnet chainId when the worker boots in workerd", async () => {
    const response = await SELF.fetch("http://gateway.local/healthz");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, chainId: 296 });
  });
});
