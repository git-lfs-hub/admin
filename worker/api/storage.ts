import { Hono, type Context } from 'hono';

import type { AppEnv } from '@/_env';
import { notify } from '@/alerts/lifecycle';
import { Registry, type StorageRow } from '@/db/registry';
import { Storage } from '@/db/storage';
import { isoAddDays } from '@/lib/time';
import { blockPrefix, unblockPrefix } from '@/server/lfs-server';

/** Resolve the storage row for the prefix's URL-path segments (same-key match), or a 404. */
async function resolveStorage(c: Context<AppEnv>): Promise<StorageRow | Response> {
  const { owner, repo } = c.req.param();
  const cur = await Registry.global(c.env).storageForRepo(owner, repo);
  return cur ?? c.json({ error: 'not_found' }, 404);
}

const app = new Hono<AppEnv>()
  .get('/', async (c) => {
    const registry = Registry.global(c.env);
    const [rows, repos] = await Promise.all([registry.listStorage(), registry.listRepos()]);
    // Same-key cross-link: lc(prefix) ⇔ lc(owner/repo). Inferred 1:1 by path, not `.lfsconfig`.
    const reposByKey = new Map(repos.map((r) => [`${r.owner}/${r.repo}`, r]));
    const gc = c.env.GC;
    const archiveDays = gc.autoArchiveDays;
    const retentionDays = gc.coldStorage
      ? gc.coldStorageRetentionDays
      : gc.liveStorageRetentionDays;
    const result = await Promise.all(
      rows.map(async (row) => {
        const store = Storage.byPrefix(c.env, row.prefix);
        const [usage, lastAccessedAt] = await Promise.all([store.usage(), store.lastAccessedAt()]);
        const [owner, repo] = row.prefix.split('/');
        const gitRepo = reposByKey.get(row.prefix.toLowerCase());
        return {
          ...row,
          owner,
          repo,
          name: row.prefix,
          usage,
          lastAccessedAt,
          // The git repo this prefix is inferred to serve (same-key), if one is tracked.
          gitRepo: gitRepo
            ? { owner: gitRepo.owner, repo: gitRepo.repo, status: gitRepo.status }
            : null,
          // Only an `unused`, not-yet-blocked prefix has an auto-archive deadline.
          willArchiveAt:
            row.status === 'unused' && !row.archivedAt && row.unusedAt
              ? isoAddDays(row.unusedAt, archiveDays)
              : null,
          willPurgeAt: row.archivedAt ? isoAddDays(row.archivedAt, retentionDays) : null,
        };
      }),
    );
    return c.json({ storage: result });
  })

  // Block = serve-block. RPC before the DB write so a failure leaves the row unchanged.
  // `unused`-only: blocking a `used` prefix (live git repo) would be auto-unblocked by
  // reconcile (present + blocked) until block-reason tracking exists.
  .post('/:owner/:repo/archive', async (c) => {
    const cur = await resolveStorage(c);
    if (cur instanceof Response) return cur;
    if (cur.status !== 'unused') return c.json({ error: 'invalid_state', status: cur.status }, 409);
    if (cur.archivedAt) return c.json({ error: 'already_blocked' }, 409);
    try {
      await blockPrefix(c.env, cur.prefix);
    } catch (e) {
      console.error(`[archive] blockRepo failed for ${cur.prefix}:`, e);
      return c.json({ error: 'lfs_server_unavailable' }, 502);
    }
    const row = await Registry.global(c.env).block(cur.prefix);
    if (!row) return c.json({ error: 'invalid_state' }, 409);
    await notify(c.env, c.req.param('owner'), c.req.param('repo'), 'archived');
    return c.json({ storage: row });
  })

  // Unblock (undo Block) = clear the serve-block. Status untouched — never forces
  // `used` (link state is reconcile's call). RPC before the DB write. Cold restore
  // (clearedAt set → Glacier) is Group D3.
  .post('/:owner/:repo/restore', async (c) => {
    const cur = await resolveStorage(c);
    if (cur instanceof Response) return cur;
    if (!cur.archivedAt) return c.json({ error: 'not_blocked' }, 409);
    try {
      await unblockPrefix(c.env, cur.prefix);
    } catch (e) {
      console.error(`[restore] unblockRepo failed for ${cur.prefix}:`, e);
      return c.json({ error: 'lfs_server_unavailable' }, 502);
    }
    const row = await Registry.global(c.env).unblock(cur.prefix);
    if (!row) return c.json({ error: 'invalid_state' }, 409);
    await notify(c.env, c.req.param('owner'), c.req.param('repo'), 'restored');
    return c.json({ storage: row });
  })

  // Destructive / cold-storage ops land in Groups D and E.
  .post('/:owner/:repo/backup', (c) => c.json({ error: 'not_implemented' }, 501))
  .delete('/:owner/:repo/backup', (c) => c.json({ error: 'not_implemented' }, 501))
  .post('/:owner/:repo/clear', (c) => c.json({ error: 'not_implemented' }, 501))
  .post('/:owner/:repo/purge', (c) => c.json({ error: 'not_implemented' }, 501));

export default app;
