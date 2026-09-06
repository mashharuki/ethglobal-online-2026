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
    const problems = validateAgainstSchema(TOKEN_TIMELINE_QUERY, {
      rightsToken: "RightsToken",
      licenseEpochChanges: "LicenseEpochChange",
    });
    expect(problems).toEqual([]);
    expect(
      validateAgainstSchema(
        '{ rightsToken(id: "1") { id nope owner { id } } }',
        {
          rightsToken: "RightsToken",
        },
      ),
    ).toEqual(["RightsToken.nope is not in the schema"]);
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

/** Walks the query's selection sets and reports fields the schema does not have. */
function validateAgainstSchema(
  query: string,
  roots: Record<string, string>,
): string[] {
  const schema = loadSchema();
  const problems: string[] = [];
  // strip the operation header and arguments, keep names + braces
  const body = query
    .replace(/^query\s+\w+\s*\([^)]*\)/, "")
    .replace(/\([^)]*\)/g, "");
  const tokens = body.match(/[A-Za-z_]\w*|[{}]/g) ?? [];
  const stack: Array<string | undefined> = [];
  let pending: string | undefined;
  for (const token of tokens) {
    if (token === "{") {
      stack.push(pending);
      pending = undefined;
    } else if (token === "}") {
      stack.pop();
    } else {
      const parent = stack.at(-1);
      let entity: string | undefined;
      if (stack.length <= 1) {
        entity = roots[token];
        if (entity === undefined) problems.push(`unknown root field ${token}`);
      } else if (parent !== undefined) {
        const type = schema.get(parent)?.get(token);
        if (type === undefined) {
          problems.push(`${parent}.${token} is not in the schema`);
        } else if (schema.has(type)) {
          entity = type;
        }
      }
      pending = entity;
    }
  }
  return problems;
}
