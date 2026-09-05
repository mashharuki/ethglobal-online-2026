import { defineConfig } from "vitest/config";

/**
 * Node-side gateway tests: the Postgres schema / migrations run against PGlite (real
 * Postgres semantics - UNIQUE, CHECK, FOR UPDATE - without a server). Worker-runtime specs
 * live in vitest.config.ts (workerd).
 */
export default defineConfig({
  test: {
    name: "gateway-node",
    include: ["test/node/**/*.test.ts"],
    environment: "node",
  },
});
