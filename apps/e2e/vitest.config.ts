import { defineConfig } from "vitest/config";

/** Unit tests for the E2E tooling itself (metrics maths, Postman <-> OpenAPI coverage). */
export default defineConfig({
  test: {
    include: ["*.test.ts"],
    environment: "node",
  },
});
