import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["worker/**/*.spec.ts"],
          environment: "node",
        },
      },
      {
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
        test: {
          name: "integration",
          include: ["test/worker/**/*.test.ts"],
          testTimeout: 20_000,
          hookTimeout: 20_000,
        },
      },
      {
        plugins: [vue()],
        resolve: {
          alias: {
            "@": new URL("./client", import.meta.url).pathname,
          },
        },
        test: {
          name: "client",
          include: ["test/client/**/*.test.ts"],
          environment: "happy-dom",
        },
      },
    ],
    coverage: {
      provider: "istanbul",
      reporter: ["text", "text-summary", "json", "json-summary", "lcov"],
      include: ["worker/**"],
      exclude: ["worker/**/*.spec.ts"],
      thresholds: {
        statements: 95,
        branches: 90,
        functions: 80,
        lines: 95,
      },
    },
  },
});
