import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
    expect(result?.licenseEpochChanges).toEqual(timeline.licenseEpochChanges);
    // every selection in the query exists on the entity it is selected from, per the REAL
    // subgraph schema (apps/subgraph/schema.graphql): drift there fails here
    expect(validateAgainstSchema(TOKEN_TIMELINE_QUERY)).toEqual([]);
    expect(
      validateAgainstSchema(
        '{ rightsToken(id: "1") { id nope owner { id } } }',
      ),
    ).toEqual(["RightsToken.nope is not in the schema"]);
    expect(validateAgainstSchema("{ rightsToken { id { nope } } }")).toEqual([
      "RightsToken.id is a scalar and has no sub-selection",
    ]);
    expect(validateAgainstSchema("{ unicorns { id } }")).toEqual([
      "unknown root field unicorns",
    ]);
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

/** `type X @entity { field: Type }` blocks -> entity -> field -> base type name */
function loadSchema(): Map<string, Map<string, string>> {
  const text = readFileSync(
    resolve(import.meta.dirname, "../../../subgraph/schema.graphql"),
    "utf8",
  );
  const entities = new Map<string, Map<string, string>>();
  for (const block of text.matchAll(
    /type\s+(\w+)\s+@entity[^{]*\{([^}]*)\}/g,
  )) {
    const fields = new Map<string, string>();
    for (const line of (block[2] ?? "").split("\n")) {
      const field = /^\s*(\w+)\s*:\s*([\w[\]!]+)/.exec(line);
      if (field?.[1] !== undefined && field[2] !== undefined) {
        fields.set(field[1], field[2].replace(/[[\]!]/g, ""));
      }
    }
    entities.set(block[1] ?? "", fields);
  }
  return entities;
}

/**
 * Walks the query's selection sets and reports what the schema does not have: unknown root
 * fields (The Graph derives `rightsToken` / `rightsTokens` from every entity), fields missing
 * on their entity, and sub-selections under scalars.
 */
function validateAgainstSchema(query: string): string[] {
  const schema = loadSchema();
  const roots = new Map<string, string>();
  for (const entity of schema.keys()) {
    const single = entity.charAt(0).toLowerCase() + entity.slice(1);
    roots.set(single, entity);
    roots.set(`${single}s`, entity);
  }
  const problems: string[] = [];
  const body = query
    .replace(/^\s*query\s+\w+\s*\([^)]*\)/, "")
    .replace(/\([^)]*\)/g, "");
  const tokens = body.match(/[A-Za-z_]\w*|[{}]/g) ?? [];
  // each frame: the entity whose fields are being selected, or a scalar marker
  const stack: Array<{ entity: string } | { scalar: string }> = [];
  let pending: { entity: string } | { scalar: string } | undefined;
  for (const token of tokens) {
    if (token === "{") {
      stack.push(pending ?? { entity: "Query" });
      pending = undefined;
      continue;
    }
    if (token === "}") {
      stack.pop();
      continue;
    }
    const frame = stack.at(-1);
    if (
      frame === undefined ||
      ("entity" in frame && frame.entity === "Query")
    ) {
      const entity = roots.get(token);
      if (entity === undefined) problems.push(`unknown root field ${token}`);
      pending = entity === undefined ? undefined : { entity };
      continue;
    }
    if ("scalar" in frame) {
      if (
        !problems.includes(
          `${frame.scalar} is a scalar and has no sub-selection`,
        )
      ) {
        problems.push(`${frame.scalar} is a scalar and has no sub-selection`);
      }
      pending = undefined;
      continue;
    }
    const type = schema.get(frame.entity)?.get(token);
    if (type === undefined) {
      problems.push(`${frame.entity}.${token} is not in the schema`);
      pending = undefined;
    } else if (schema.has(type)) {
      pending = { entity: type };
    } else {
      pending = { scalar: `${frame.entity}.${token}` };
    }
  }
  return problems;
}
