import { Hono } from 'hono';

import type { AppEnv } from '@/_env';
import { Registry } from '@/db/registry';

// Read-only: presence is reconcile's/the webhook's call. Lifecycle actions live on `/api/storage`.
const app = new Hono<AppEnv>().get('/', async (c) => {
  const registry = Registry.global(c.env);
  const [repos, storage] = await Promise.all([registry.listRepos(), registry.listStorage()]);
  // Cross-link inferred 1:1 by lowercased path, not `.lfsconfig`.
  const storageByKey = new Map(storage.map((s) => [s.prefix.toLowerCase(), s]));
  const result = repos.map((row) => {
    const store = storageByKey.get(`${row.owner}/${row.repo}`);
    return {
      ...row,
      storage: store
        ? { prefix: store.prefix, status: store.status, archivedAt: store.archivedAt }
        : null,
    };
  });
  return c.json({ repos: result });
});

export default app;
