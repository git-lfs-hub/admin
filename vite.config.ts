import { defineConfig } from 'vite'
import { cloudflare } from '@cloudflare/vite-plugin'
import vue from '@vitejs/plugin-vue'
import * as vueCompilerSfc from 'vue/compiler-sfc'
import tailwindcss from '@tailwindcss/vite'

// plugin-vue resolves its SFC compiler lazily in `buildStart`, which under the
// @cloudflare/vite-plugin multi-environment dev server doesn't run before the
// first HMR file-change. Its deprecated `handleHotUpdate` then dereferences a
// null compiler (`options.value.compiler.invalidateTypeCache`), crashing every
// save. Seed the compiler upfront — buildStart keeps a pre-set one (`compiler
// || resolveCompiler()`).
const vuePlugin = vue()
;(vuePlugin as { api: { options: { compiler: unknown } } }).api.options.compiler = vueCompilerSfc

export default defineConfig(({ command }) => ({
  // Dev server (serve) keeps the @dev fixture reconcile; the deployed worker is bundled by
  // wrangler (define __DEV__=false in wrangler.jsonc), which strips it.
  define: {
    __DEV__: JSON.stringify(command === 'serve'),
  },
  resolve: {
    tsconfigPaths: true,
  },
  plugins: [
    vuePlugin,
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
