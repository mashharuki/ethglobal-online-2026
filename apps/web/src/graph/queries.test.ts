import { describe, expect, it } from "vitest";
import { createApi } from "../api/client";
import {
  fetchTokenTimeline,
  short,
  TOKEN_TIMELINE_QUERY,
  type TokenTimeline,
  toEpochLanes,
} from "./queries";

const timeline: TokenTimeline = {
  id: "1",
  accessEpoch: "3",
  licenseEpoch: "1",
  owner: { id: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
  transfers: [
    {
      from: "0x0000000000000000000000000000000000000000",
      to: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      blockNumber: "10",
      timestamp: "1",
    },
    {
      from: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      to: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      blockNumber: "30",
      timestamp: "3",
    },
  ],
  receipts: [],
  allocations: [],
  licenseEpochChanges: [{ newEpoch: "1", blockNumber: "20" }],
};

describe("Rights Graph queries (T106)", () => {
  it("should lay the two epoch lanes out in block order", () => {
    const lanes = toEpochLanes(timeline);
    expect(lanes.map((l) => `${l.lane}:${l.epoch}@${l.blockNumber}`)).toEqual([
      "owner:1@10",
      "license:1@20",
      "owner:2@30",
    ]);
    expect(lanes[0]?.label).toBe("mint -> 0xaaaa…aaaa");
  });

  it("should query through the gateway /graph passthrough and unwrap the token", async () => {
    let seen: { query: string; variables: unknown } | undefined;
    let target: { url: string; method: string } | undefined;
    const api = createApi("http://gateway.test", async (input, init) => {
      const req = new Request(input, init);
      target = { url: req.url, method: req.method };
      seen = (await req.json()) as typeof seen;
      return Response.json({
        data: {
          rightsToken: { ...timeline, licenseEpochChanges: undefined },
          licenseEpochChanges: timeline.licenseEpochChanges,
        },
      });
    });
    const result = await fetchTokenTimeline(api, "1");
    expect(target).toEqual({
      url: "http://gateway.test/graph",
      method: "POST",
    });
    expect(seen).toEqual({
      query: TOKEN_TIMELINE_QUERY,
      variables: { id: "1" },
    });
    // every requested field exists in contracts/subgraph-schema.md (no invented fields)
    const schemaFields = new Set([
      "id",
      "accessEpoch",
      "licenseEpoch",
      "owner",
      "transfers",
      "from",
      "to",
      "blockNumber",
      "timestamp",
      "receipts",
      "licensee",
      "transferMode",
      "usedCount",
      "maxUses",
      "expiresAt",
      "allocations",
      "ownerAmount",
      "creator",
      "creatorAmount",
      "licenseEpochChanges",
      "newEpoch",
      "rightsToken",
    ]);
    const requested =
      TOKEN_TIMELINE_QUERY.replace(/\(.*?\)/g, "")
        .replace(/query\s+\w+/, "")
        .match(/[A-Za-z]+/g) ?? [];
    for (const field of requested) {
      expect(schemaFields.has(field), `unknown field ${field}`).toBe(true);
    }
    expect(result?.licenseEpochChanges).toEqual(timeline.licenseEpochChanges);
    const missing = createApi("http://gateway.test", async () =>
      Response.json({ data: { rightsToken: null, licenseEpochChanges: [] } }),
    );
    expect(await fetchTokenTimeline(missing, "9")).toBeUndefined();
    const failing = createApi("http://gateway.test", async () =>
      Response.json({ errors: [{ message: "boom" }] }),
    );
    await expect(fetchTokenTimeline(failing, "1")).rejects.toMatchObject({
      code: "GRAPH_ERROR",
    });
  });

  it("should shorten addresses", () => {
    expect(short("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBe(
      "0xaaaa…aaaa",
    );
    expect(short("short")).toBe("short");
  });
});
