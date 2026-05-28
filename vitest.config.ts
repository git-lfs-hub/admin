import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig, defineProject } from "vitest/config";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  test: {
    projects: [
      defineProject({
        resolve: { tsconfigPaths: true },
        test: {
          name: "unit",
          include: ["worker/**/*.spec.ts"],
          environment: "node",
        },
      }),
      defineProject({
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./test/worker/wrangler.jsonc" },
          }),
        ],
        resolve: { tsconfigPaths: true },
        test: {
          name: "integration",
          include: ["test/worker/**/*.test.ts"],
          testTimeout: 20_000,
          hookTimeout: 20_000,
        },
      }),
      defineProject({
        plugins: [vue()],
        resolve: { tsconfigPaths: true },
        test: {
          name: "client",
          include: ["client/**/*.spec.ts"],
          environment: "happy-dom",
        },
      }),
    ],
    coverage: {
      provider: "istanbul",
      reporter: ["text", "text-summary", "json", "json-summary", "lcov"],
      include: ["worker/**/*.ts", "client/**/*.ts"],
      exclude: ["**/*.spec.ts", "**/*.test.ts", "**/*.d.ts"],
      thresholds: {
        statements: 90,
        branches: 80,
        functions: 80,
        lines: 90,
      },
    },
  },
});
