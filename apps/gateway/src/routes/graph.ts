import type { Hono } from "hono";
import { z } from "zod";
import { type AppEnv, parseBody } from "./schemas";

/**
 * Rights Graph pass-through (tasks.md T090, FR-020). Discovery / audit only - the result of
 * this endpoint is never used for authorization (constitution II). The subgraph being down
 * is a 502 with the `{ error }` envelope, not a domain error.
 */
const GraphBody = z.object({
  query: z.string().min(1).max(20_000),
  variables: z.record(z.string(), z.unknown()).optional(),
  operationName: z.string().max(200).optional(),
});

export function registerGraphRoutes(app: Hono<AppEnv>): void {
  app.post("/graph", async (c) => {
    const services = c.get("services");
    const body = await parseBody(c, GraphBody);
    try {
      const result = await services.graph(body.query, body.variables);
      return c.json(result);
    } catch (error) {
      console.error("subgraph proxy failed", {
        name: error instanceof Error ? error.name : "unknown",
      });
      return c.json({ error: "subgraph_unreachable" }, 502);
    }
  });
}
