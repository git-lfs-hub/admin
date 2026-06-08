import { Hono } from 'hono';

import type { AppEnv } from '@/_env';
import { Registry } from '@/db/registry';

// GitHub presence (git identity) — read-only. Presence is reconciliation's / the webhook's
// call, never an admin mutation; lifecycle actions live on the storage prefix (`/api/storage`).
const app = new Hono<AppEnv>().get('/', async (c) => {
  const registry = Registry.global(c.env);
  const [repos, storage] = await Promise.all([registry.listRepos(), registry.listStorage()]);
  // Same-key cross-link: lc(owner/repo) ⇔ lc(prefix). Inferred 1:1 by path, not `.lfsconfig`.
  const storageByKey = new Map(storage.map((s) => [s.prefix.toLowerCase(), s]));
  const result = repos.map((row) => {
    const store = storageByKey.get(`${row.owner}/${row.repo}`);
    return {
      ...row,
      // The storage prefix this repo is inferred to use (same-key), if discovered.
      storage: store
        ? { prefix: store.prefix, status: store.status, archivedAt: store.archivedAt }
        : null,
    };
  });
  return c.json({ repos: result });
});

export default app;
