import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The Newman collection (tasks.md T098) must only exercise paths that exist in the openapi
 * contract, with the methods the contract declares: the collection cannot drift away from
 * packages/openapi/openapi.yaml without failing here.
 */
type Item = {
  name: string;
  request: { method: string; url: { path: string[] } };
  event?: Array<{ listen: string; script: { exec: string[] } }>;
};

const collection = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, "postman/gateway.postman_collection.json"),
    "utf8",
  ),
) as { item: Item[] };

const openapi = readFileSync(
  resolve(import.meta.dirname, "../../packages/openapi/openapi.yaml"),
  "utf8",
);

/** "  /assets/{assetId}/paid:" lines -> template; the methods indented beneath them */
function declaredPaths(): Map<string, Set<string>> {
  const paths = new Map<string, Set<string>>();
  let current: string | undefined;
  for (const line of openapi.split("\n")) {
    const path = /^ {2}(\/[^:]*):\s*$/.exec(line);
    if (path?.[1] !== undefined) {
      current = path[1];
      paths.set(current, new Set());
      continue;
    }
    const method = /^ {4}(get|post|put|delete|patch):\s*$/.exec(line);
    if (method?.[1] !== undefined && current !== undefined) {
      paths.get(current)?.add(method[1].toUpperCase());
    }
  }
  return paths;
}

/** Resolves a concrete request path to the declared template it instantiates ({param} = any segment). */
function templateOf(
  segments: string[],
  declared: Map<string, Set<string>>,
): string {
  const concrete = `/${segments.join("/")}`;
  for (const template of declared.keys()) {
    const parts = template.split("/");
    if (parts.length !== segments.length + 1) continue;
    const matches = parts.every(
      (part, i) => i === 0 || part.startsWith("{") || part === segments[i - 1],
    );
    if (matches) return template;
  }
  return concrete;
}

describe("Newman collection vs openapi (T098 / FR-029)", () => {
  const paths = declaredPaths();

  it("should parse the contract paths", () => {
    expect(paths.get("/assets/{assetId}/paid")).toEqual(
      new Set(["GET", "POST"]),
    );
    expect(paths.has("/mcp")).toBe(true);
  });

  it("should only request declared paths and methods, each with assertions", () => {
    expect(collection.item.length).toBeGreaterThan(20);
    for (const item of collection.item) {
      const template = templateOf(item.request.url.path, paths);
      const methods = paths.get(template);
      expect(
        methods,
        `${item.name}: ${template} is not in openapi.yaml`,
      ).toBeDefined();
      expect(
        methods?.has(item.request.method),
        `${item.name}: ${item.request.method} ${template}`,
      ).toBe(true);
      const tests =
        item.event?.find((e) => e.listen === "test")?.script.exec ?? [];
      expect(
        tests.some((line) => line.includes("pm.test(")),
        `${item.name} has no pm.test`,
      ).toBe(true);
    }
  });

  it("should cover every route group of the gateway", () => {
    const covered = new Set(
      collection.item.map((i) => templateOf(i.request.url.path, paths)),
    );
    for (const required of [
      "/healthz",
      "/assets",
      "/assets/{assetId}/preview",
      "/assets/{assetId}/paid",
      "/owner/challenge",
      "/owner/keygate",
      "/keygate/challenge",
      "/keygate/share",
      "/graph",
      "/audit",
      "/assets/{assetId}/bump-license-epoch",
      "/mcp",
    ]) {
      expect(covered.has(required), `${required} is not exercised`).toBe(true);
    }
  });
});
