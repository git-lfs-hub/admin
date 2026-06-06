import { Hono } from 'hono';
import { isoAddDays } from '@/lib/time';
import { lfsServer } from '@/server/lfs-server';
import type { AppEnv } from '@/_env';

const app = new Hono<AppEnv>().get('/', async (c) => {
  const repos = c.env.REPOS.getByName('global');
  const rows = await repos.listAll();
  const gc = c.env.GC;
  const archiveDays = gc.autoArchiveDays;
  const retentionDays = gc.coldStorage ? gc.coldStorageRetentionDays : gc.liveStorageRetentionDays;
  const result = await Promise.all(
    rows.map(async (row) => {
      const repo = c.env.REPO.getByName(row.name);
      const [usage, lastAccessedAt] = await Promise.all([repo.usage(), repo.lastAccessedAt()]);
      return {
        ...row,
        usage,
        lastAccessedAt,
        willArchiveAt:
          row.status === 'missing' && row.missingAt ? isoAddDays(row.missingAt, archiveDays) : null,
        willPurgeAt: row.archivedAt ? isoAddDays(row.archivedAt, retentionDays) : null,
      };
    }),
  );
  return c.json({ repos: result });
});

export default app;
