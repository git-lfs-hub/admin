# Development

## Deploy repo pipeline

In **[git-lfs-hub/deploy](https://github.com/git-lfs-hub/deploy)**, `bun run config` renders `wrangler.admin.jsonc` and `worker-configuration.admin.d.ts` at the repo root and symlinks them into `admin/`. Run `turbo dev`, `turbo build`, or `turbo deploy` from the monorepo root — `@git-lfs-hub/admin#{build,test,deploy}` integrate with the Turbo task graph.

## Standalone development

Use this when you work from **[git-lfs-hub/admin](https://github.com/git-lfs-hub/admin)** only. Keep local `wrangler.jsonc` and `worker-configuration.d.ts` — the deploy checkout normally supplies these via symlinks.

```sh
bun install
bun run dev       # vite dev — local Vue dev server
bun run test      # vitest (integration via @cloudflare/vitest-pool-workers)
bun run types     # regenerate worker-configuration.d.ts after changing wrangler.jsonc bindings
```

## Standalone deployment

With Cloudflare auth in place (`wrangler login` or `CLOUDFLARE_API_TOKEN`) and secrets applied:

```sh
wrangler secret put GITHUB_CLIENT_ID
wrangler secret put GITHUB_CLIENT_SECRET
wrangler secret put LOGIN_SECRET   # openssl rand -hex 32
```

```sh
bun run deploy
```

Full releases use **[git-lfs-hub/deploy](https://github.com/git-lfs-hub/deploy)** (`turbo deploy`).

--- UPDATES: ---

```sh
bun install
bun run dev
```

```sh
bun run deploy
```

[For generating/synchronizing types based on your Worker configuration run](https://developers.cloudflare.com/workers/wrangler/commands/#types):

```sh
bun run cf-typegen
```

Pass the `CloudflareBindings` as generics when instantiation `Hono`:

```ts
// src/index.ts
const app = new Hono<{ Bindings: CloudflareBindings }>()
```
