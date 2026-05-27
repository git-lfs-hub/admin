import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    coverage: {
      provider: "istanbul", // v8 isn't supported by vitest-pool-workers
      reporter: ["text", "text-summary", "json", "json-summary", "lcov"],
      exclude: ["test"],
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 85,
      },
    },
  },
});
