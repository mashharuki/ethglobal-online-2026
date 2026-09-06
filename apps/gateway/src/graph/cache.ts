import { eq } from "drizzle-orm";
import { subgraphCache } from "../db/schema";
import type { Db } from "../db/types";

/**
 * subgraph_cache (tasks.md T085, FR-020): short-TTL cache in front of the Rights Graph for
 * discovery / dashboard freshness. NEVER consulted for authorization (constitution II).
 */
const DEFAULT_GRAPH_TTL_SEC = 15;

export type GraphResponse<T> = {
  data?: T;
  errors?: Array<{ message: string }>;
};

export type GraphFetch = <T>(
  query: string,
  variables?: Record<string, unknown>,
) => Promise<GraphResponse<T>>;

export function createGraphFetch(
  subgraphUrl: string,
  fetchImpl: typeof fetch = fetch,
): GraphFetch {
  return async (query, variables) => {
    if (subgraphUrl === "") {
      return { errors: [{ message: "SUBGRAPH_URL is not configured" }] };
    }
    const response = await fetchImpl(subgraphUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) {
      throw new Error(`subgraph answered ${response.status}`);
    }
    return (await response.json()) as GraphResponse<never>;
  };
}

/** The caller's cache key must distinguish the query and every variable affecting its result. */
export async function cachedGraphQuery<T>(
  db: Db,
  graph: GraphFetch,
  key: string,
  query: string,
  variables: Record<string, unknown> | undefined,
  options: { ttlSec?: number; now?: () => Date } = {},
): Promise<GraphResponse<T>> {
  const ttlMs = (options.ttlSec ?? DEFAULT_GRAPH_TTL_SEC) * 1000;
  const now = (options.now ?? (() => new Date()))();
  const [cached] = await db
    .select()
    .from(subgraphCache)
    .where(eq(subgraphCache.key, key))
    .limit(1);
  if (
    cached !== undefined &&
    now.getTime() - cached.refreshedAt.getTime() < ttlMs
  ) {
    return cached.value as GraphResponse<T>;
  }
  const fresh = await graph<T>(query, variables);
  // GraphQL can return HTTP 200 with errors or partial data; do not cache that as a healthy
  // discovery result and hide a recovered indexer for the rest of the TTL.
  if (fresh.errors === undefined) {
    await db
      .insert(subgraphCache)
      .values({ key, value: fresh, refreshedAt: now })
      .onConflictDoUpdate({
        target: subgraphCache.key,
        set: { value: fresh, refreshedAt: now },
      });
  }
  return fresh;
}

export const LIST_TOKENS_QUERY = `query ListTokens($first: Int!) {
  rightsTokens(first: $first, where: { hydrated: true }, orderBy: id) {
    id assetId creator manifestURI accessEpoch licenseEpoch owner { id }
  }
}`;

export type GraphToken = {
  id: string;
  assetId: string;
  creator: string;
  manifestURI: string;
  accessEpoch: string;
  licenseEpoch: string;
  owner: { id: string };
};
