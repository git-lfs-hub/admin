import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'test/e2e',
  timeout: 30_000,
  use: {
    baseURL: 'http://localhost:5173',
    headless: true,
  },
  webServer: {
    command: 'bun run dev',
    port: 5173,
    reuseExistingServer: true,
    timeout: 30_000,
  },
})
