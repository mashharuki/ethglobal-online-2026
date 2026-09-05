import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "agent",
    include: ["test/**/*.spec.ts", "test/**/*.test.ts"],
  },
});
