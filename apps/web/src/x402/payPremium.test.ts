import type { ClientHederaSigner } from "@x402/hedera";
import { afterEach, describe, expect, it, vi } from "vitest";

import { payPremium } from "./payPremium";

const noopSigner: ClientHederaSigner = {
  accountId: "0.0.5005",
  createPartiallySignedTransferTransaction: async () => "",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("payPremium", () => {
  it("returns the JSON body when the resource responds 200 without payment", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ message: "ok", priceTinybars: "1000" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const result = await payPremium(noopSigner, "http://localhost:4021");
    expect(result.body).toEqual({ message: "ok", priceTinybars: "1000" });
  });

  it("throws with the status when the resource responds with an error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("nope", { status: 500 }),
    );
    await expect(
      payPremium(noopSigner, "http://localhost:4021"),
    ).rejects.toThrow("500");
  });

  it("requests the /premium path on the configured server", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ message: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await payPremium(noopSigner, "http://localhost:4021");
    const arg = spy.mock.calls[0]?.[0];
    const calledUrl = arg instanceof Request ? arg.url : String(arg ?? "");
    expect(calledUrl).toContain("/premium");
    expect(calledUrl).toContain("localhost:4021");
  });
});
