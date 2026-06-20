import { Hono } from 'hono';

import type { AppEnv } from '@/_env';
import { groupBy } from '@/api/cross-link';
import { Registry } from '@/db/registry';

// Read-only: presence is reconcile's/the webhook's call. Lifecycle actions live on `/api/storage`.
const app = new Hono<AppEnv>().get('/', async (c) => {
  const registry = Registry.global(c.env);
  const [repos, links] = await Promise.all([registry.listRepos(), registry.listActiveRepoLinks()]);
  // Real git→prefix cross-link from `links` (a repo can consume N prefixes), not a same-key guess.
  const storageByRepo = groupBy(
    links,
    (l) => `${l.owner}/${l.repo}`,
    (l) => ({
      prefix: l.prefix,
      status: l.status,
      archivedAt: l.archivedAt,
    }),
  );
  const result = repos.map((row) => ({
    ...row,
    storage: storageByRepo.get(`${row.owner}/${row.repo}`) ?? [],
  }));
  return c.json({ repos: result });
});

export default app;
