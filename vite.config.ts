import { defineConfig } from 'vite'
import { cloudflare } from '@cloudflare/vite-plugin'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig(({ command }) => ({
  plugins: [
    vue(),
    tailwindcss(),
    ...(command === 'serve'
      ? [
          cloudflare({
            persistState: true,
            auxiliaryWorkers: [
              {
                configPath: '../server/wrangler.jsonc',
                config: (config) => {
                  config.main = 'dev/entry.ts'
                },
              },
            ],
          }),
        ]
      : []),
  ],
  resolve: {
    alias: {
      '@': new URL('./client', import.meta.url).pathname,
    },
  },
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
