import { cloudflare } from '@cloudflare/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';
import * as vueCompilerSfc from 'vue/compiler-sfc';

import vars from './vars.json';

const htmlVarsPlugin = {
  name: 'html-vars',
  transformIndexHtml(html: string) {
    return html.replace(/<title>.*<\/title>/, `<title>${vars.admin.title}</title>`);
  },
};

// plugin-vue resolves its SFC compiler lazily in `buildStart`, which under the
// @cloudflare/vite-plugin multi-environment dev server doesn't run before the
// first HMR file-change. Its deprecated `handleHotUpdate` then dereferences a
// null compiler (`options.value.compiler.invalidateTypeCache`), crashing every
// save. Seed the compiler upfront — buildStart keeps a pre-set one (`compiler
// || resolveCompiler()`).
const vuePlugin = vue();
(vuePlugin as { api: { options: { compiler: unknown } } }).api.options.compiler = vueCompilerSfc;

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
    htmlVarsPlugin,
    vuePlugin,
    tailwindcss(),
    cloudflare({
      ...(command === 'serve'
        ? {
            // server/ is the dependency; keep the shared dev state under it so
            // the auxiliary lfs-server worker and standalone `bun dev/start.ts`
            // (which persists to server/.wrangler/state) read/write one place.
            persistState: { path: '../server/.wrangler/state' },
            // Dev launches with ENV=local (see package.json `dev`) — inject it as a
            // worker var so reconcile skips GitHub (no real GitHub App key locally).
            config: (config) => {
              if (process.env.ENV) config.vars = { ...config.vars, ENV: process.env.ENV };
            },
            auxiliaryWorkers: [
              {
                configPath: '../server/wrangler.jsonc',
                config: (config) => {
                  config.main = 'dev/entry.ts';
                  if (process.env.ENV) config.vars = { ...config.vars, ENV: process.env.ENV };
                },
              },
            ],
          }
        : {}),
    }),
  ],
  server: {
    // Forwards console.error, console.warn, and unhandled errors by default
    forwardConsole: true,
    // Tests aren't part of the dev bundle — don't trigger HMR/reload on their saves.
    watch: {
      ignored: ['**/*.{spec,test}.ts'],
    },
  },
  build: {
    rollupOptions: {
      onwarn(warning, defaultHandler) {
        if (warning.message?.includes('#__PURE__')) return;
        defaultHandler(warning);
      },
    },
  },
}));
