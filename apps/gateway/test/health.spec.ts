import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("GET /healthz", () => {
  it("should report ok with the Hedera testnet chainId when the worker boots in workerd", async () => {
    const response = await SELF.fetch("http://gateway.local/healthz");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, chainId: 296 });
  });

  it("should allow the deployed web origin on normal and preflight responses", async () => {
    const origin = "https://truecollective.pages.dev";
    const response = await SELF.fetch("http://gateway.local/healthz", {
      headers: { Origin: origin },
    });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(origin);

    const preflight = await SELF.fetch("http://gateway.local/graph", {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    expect(preflight.headers.get("Access-Control-Allow-Methods")).toContain(
      "POST",
    );
  });
});
