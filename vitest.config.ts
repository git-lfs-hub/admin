import { fileURLToPath } from 'node:url';

import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import vue from '@vitejs/plugin-vue';
import { defineConfig, defineProject } from 'vitest/config';

// `Registry.global` / `Storage.byPrefix` make worker modules value-import the DO classes,
// which pull in `cloudflare:workers`. The node `unit` project has no workers runtime — alias
// the base class to a stub (unit specs never construct a DO).
const cloudflareWorkersStub = fileURLToPath(
  new URL('./test/stubs/cloudflare-workers.ts', import.meta.url),
);

export default defineConfig({
  // Tests keep the dev fixture reconcile: node/happy-dom projects set __DEV__ via their
  // own `define`; the integration pool reads it from test/worker/wrangler.test.json.
  test: {
    projects: [
      defineProject({
        define: { __DEV__: 'true' },
        resolve: {
          tsconfigPaths: true,
          alias: { 'cloudflare:workers': cloudflareWorkersStub },
        },
        test: {
          name: 'unit',
          include: ['worker/**/*.spec.ts', 'dev/**/*.spec.ts'],
          environment: 'node',
        },
      }),
      defineProject({
        plugins: [
          cloudflareTest({
            wrangler: { configPath: './test/worker/wrangler.jsonc' },
          }),
        ],
        resolve: { tsconfigPaths: true },
        test: {
          name: 'integration',
          include: ['test/worker/**/*.test.ts'],
          testTimeout: 20_000,
          hookTimeout: 20_000,
        },
      }),
      defineProject({
        plugins: [vue()],
        define: { __DEV__: 'true' },
        resolve: { tsconfigPaths: true },
        test: {
          name: 'client',
          include: ['client/**/*.spec.ts'],
          environment: 'happy-dom',
        },
      }),
    ],
    coverage: {
      provider: 'istanbul',
      reporter: ['text', 'text-summary', 'json', 'json-summary', 'lcov'],
      include: ['worker/**/*.ts', 'dev/**/*.ts', 'client/**/*.ts'],
      exclude: ['**/*.spec.ts', '**/*.test.ts', '**/*.d.ts'],
      thresholds: {
        statements: 90,
        branches: 80,
        functions: 80,
        lines: 90,
      },
    },
  },
});
