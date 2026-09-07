import { describe, expect, it, vi } from "vitest";
import { lookupTokenIdByAssetId } from "../src/graph/lookup";

const ASSET_ID = `0x${"12".repeat(32)}` as const;

describe("lookupTokenIdByAssetId", () => {
  it("reads the token id from the RightsToken entity id field", async () => {
    const fetchImpl = vi.fn(async (...args: Parameters<typeof fetch>) => {
      const init = args[1];
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables: { assetId: string };
      };
      expect(body.query).toContain("{ id }");
      expect(body.variables.assetId).toBe(ASSET_ID);
      return Response.json({ data: { rightsTokens: [{ id: "42" }] } });
    }) as typeof fetch;

    await expect(
      lookupTokenIdByAssetId(
        "https://graph.example/subgraph",
        ASSET_ID,
        fetchImpl,
      ),
    ).resolves.toBe(42n);
  });

  it("fails closed when the entity id is not numeric", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ data: { rightsTokens: [{ id: "token-42" }] } }),
    ) as typeof fetch;

    await expect(
      lookupTokenIdByAssetId(
        "https://graph.example/subgraph",
        ASSET_ID,
        fetchImpl,
      ),
    ).resolves.toBeUndefined();
  });
});
