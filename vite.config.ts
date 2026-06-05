import { defineConfig } from 'vite'
import { cloudflare } from '@cloudflare/vite-plugin'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig(({ command }) => ({
  resolve: {
    tsconfigPaths: true,
  },
  plugins: [
    vue(),
    tailwindcss(),
    ...(command === 'serve'
      ? [
          cloudflare({
            persistState: true,
            // Dev launches with ENV=local (see package.json `dev`) — inject it as a
            // worker var so reconcile skips GitHub (no real GitHub App key locally).
            config: (config) => {
              if (process.env.ENV) config.vars = { ...config.vars, ENV: process.env.ENV }
            },
            auxiliaryWorkers: [
              {
                configPath: '../server/wrangler.jsonc',
                config: (config) => {
                  config.main = 'dev/entry.ts'
                  if (process.env.ENV) config.vars = { ...config.vars, ENV: process.env.ENV }
                },
              },
            ],
          }),
        ]
      : []),
  ],
  server: {
    // Forwards console.error, console.warn, and unhandled errors by default
    forwardConsole: true
  },
  build: {
    rollupOptions: {
      onwarn(warning, defaultHandler) {
        if (warning.message?.includes('#__PURE__')) return
        defaultHandler(warning)
      },
    },
  },
}))
