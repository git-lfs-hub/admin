import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import vue from "@vitejs/plugin-vue";
import { defineConfig, defineProject } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      defineProject({
        resolve: { tsconfigPaths: true },
        test: {
          name: "unit",
          include: ["**/*.spec.ts"],
          environment: "node",
        },
      }),
      defineProject({
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./test/worker/wrangler.jsonc" },
            miniflare: {
              workers: [
                {
                  name: "lfs-server-mock",
                  modules: true,
                  scriptPath: "./test/worker/server/lfs-server-mock.js",
                },
              ],
            },
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
          include: ["test/client/**/*.test.ts"],
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
