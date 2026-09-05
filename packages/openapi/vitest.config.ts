import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "openapi",
    include: ["test/**/*.test.ts"],
  },
});
