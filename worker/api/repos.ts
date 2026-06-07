import { Hono } from 'hono';
import { isoAddDays } from '@/lib/time';
import { lfsServer } from '@/server/lfs-server';
import type { AppEnv } from '@/_env';

const app = new Hono<AppEnv>()
  .get('/', async (c) => {
    const repos = c.env.REPOS.getByName('global');
    const rows = await repos.listAll();
    const gc = c.env.GC;
    const archiveDays = gc.autoArchiveDays;
    const retentionDays = gc.coldStorage
      ? gc.coldStorageRetentionDays
      : gc.liveStorageRetentionDays;
    const result = await Promise.all(
      rows.map(async (row) => {
        const repo = c.env.REPO.getByName(row.name);
        const [usage, lastAccessedAt] = await Promise.all([repo.usage(), repo.lastAccessedAt()]);
        return {
          ...row,
          usage,
          lastAccessedAt,
          // Only a still-missing, not-yet-blocked repo has an auto-archive deadline.
          willArchiveAt:
            row.status === 'missing' && !row.archivedAt && row.missingAt
              ? isoAddDays(row.missingAt, archiveDays)
              : null,
          willPurgeAt: row.archivedAt ? isoAddDays(row.archivedAt, retentionDays) : null,
        };
      }),
    );
    return c.json({ repos: result });
  })
  // Archive = serve-block. RPC before the DB write so a failure leaves the row unchanged.
  // `missing`-only: blocking an `active` repo would be auto-unblocked by reconcile
  // (present + blocked) until block-reason tracking exists.
  .post('/:owner/:repo/archive', async (c) => {
    const { owner, repo } = c.req.param();
    const repos = c.env.REPOS.getByName('global');
    const cur = await repos.get(owner, repo);
    if (!cur) return c.json({ error: 'not_found' }, 404);
    if (cur.status !== 'missing')
      return c.json({ error: 'invalid_state', status: cur.status }, 409);
    if (cur.archivedAt) return c.json({ error: 'already_blocked' }, 409);
    try {
      await lfsServer(c.env).blockRepo(owner, repo);
    } catch (e) {
      console.error(`[archive] blockRepo failed for ${cur.name}:`, e);
      return c.json({ error: 'lfs_server_unavailable' }, 502);
    }
    const row = await repos.block(owner, repo);
    if (!row) return c.json({ error: 'invalid_state' }, 409);
    return c.json({ repo: row });
  })
  // Restore (undo Archive) = clear the serve-block. Status untouched — never forces
  // `active` (presence is reconcile's call). RPC before the DB write. Cold restore
  // (clearedAt set → Glacier) is Group D3.
  .post('/:owner/:repo/restore', async (c) => {
    const { owner, repo } = c.req.param();
    const repos = c.env.REPOS.getByName('global');
    const cur = await repos.get(owner, repo);
    if (!cur) return c.json({ error: 'not_found' }, 404);
    if (!cur.archivedAt) return c.json({ error: 'not_blocked' }, 409);
    try {
      await lfsServer(c.env).unblockRepo(owner, repo);
    } catch (e) {
      console.error(`[restore] unblockRepo failed for ${cur.name}:`, e);
      return c.json({ error: 'lfs_server_unavailable' }, 502);
    }
    const row = await repos.unblock(owner, repo);
    if (!row) return c.json({ error: 'invalid_state' }, 409);
    return c.json({ repo: row });
  })
  // Destructive / cold-storage ops land in Groups C and D.
  .post('/:owner/:repo/backup', (c) => c.json({ error: 'not_implemented' }, 501))
  .delete('/:owner/:repo/backup', (c) => c.json({ error: 'not_implemented' }, 501))
  .post('/:owner/:repo/clear', (c) => c.json({ error: 'not_implemented' }, 501))
  .post('/:owner/:repo/purge', (c) => c.json({ error: 'not_implemented' }, 501));

export default app;
