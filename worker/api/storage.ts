import { sha256hex } from '@git-lfs-hub/lib/crypto';
import { Hono, type Context, type Next } from 'hono';

import type { AppEnv } from '@/_env';
import { scopeFor } from '@/alerts/message';
import { Alerts } from '@/db/alerts';
import { Registry, type StorageRow } from '@/db/registry';
import { Storage } from '@/db/storage';
import { gcConfig } from '@/gc/config';
import { isLocal } from '@/lib/host';
import { isoAddDays } from '@/lib/time';
import { archive, restore } from '@/server/operations';
import { startBackup } from '@/workflows/backup';
import { purgeInstanceId, startPurge, wakePurge } from '@/workflows/purge';

// `:owner/:repo` routes carry the resolved storage row in `c.var.storage`.
type StorageEnv = {
  Bindings: CloudflareBindings;
  Variables: AppEnv['Variables'] & { storage: StorageRow };
};

const app = new Hono<StorageEnv>()
  .get('/', async (c) => {
    const registry = Registry.global(c.env);
    const [rows, repos] = await Promise.all([registry.listStorage(), registry.listRepos()]);
    // Prefix ⇔ git repo inferred 1:1 by lowercased path, not `.lfsconfig`.
    const reposByKey = new Map(repos.map((r) => [`${r.owner}/${r.repo}`, r]));
    const gc = gcConfig(c.env);
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
          gitRepo: gitRepo
            ? { owner: gitRepo.owner, repo: gitRepo.repo, status: gitRepo.status }
            : null,
          // Only an `unused`, not-yet-blocked prefix has an auto-archive deadline.
          willArchiveAt:
            row.status === 'unused' && !row.archivedAt && row.unusedAt
              ? isoAddDays(row.unusedAt, archiveDays)
              : null,
          willPurgeAt: row.archivedAt ? isoAddDays(row.archivedAt, retentionDays) : null,
          // In-flight Purge confirm deadline. Op started at `updatedAt` (`beginOp` bumps it,
          // nothing rewrites the row while waiting), so the gate proceeds `purgeConfirmDays`
          // later. Computed here for the UI countdown — avoids a STORAGE DO fan-out.
          purgeConfirmBy:
            row.activeOp === 'purge' ? isoAddDays(row.updatedAt, gc.purgeConfirmDays) : null,
        };
      }),
    );
    return c.json({ storage: result });
  })

  // Gate + resolve the row for every per-repo mutation, once (guard first — cross-owner
  // writes 403 before the lookup). GET `/` above stays global.
  .use('/:owner/:repo/*', requireOwnerAdmin, withStorage)

  // Serve-block. RPC before the DB write so a failure leaves the row unchanged. `unused`-only:
  // reconcile would auto-unblock a `used` (live) prefix until block-reason tracking exists.
  .post('/:owner/:repo/archive', async (c) => {
    const cur = c.var.storage;
    if (cur.status !== 'unused') return c.json({ error: 'invalid_state', status: cur.status }, 409);
    if (cur.archivedAt) return c.json({ error: 'already_blocked' }, 409);
    let row: StorageRow | null;
    try {
      row = await archive(c.env, Registry.global(c.env), cur.prefix);
    } catch (e) {
      console.error(`[archive] blockRepo failed for ${cur.prefix}:`, e);
      return c.json({ error: 'lfs_server_unavailable' }, 502);
    }
    if (!row) return c.json({ error: 'invalid_state' }, 409);
    return c.json({ storage: row });
  })

  // Clear the serve-block. Status untouched — link state is reconcile's call. RPC before the
  // DB write. Cold restore (clearedAt set → Glacier) is not yet wired.
  .post('/:owner/:repo/restore', async (c) => {
    const cur = c.var.storage;
    // Purged objects are gone; an in-flight purge is mid-delete — neither serves, so unblocking
    // is meaningless. Gate both before the block check (a purged row keeps its `archivedAt`).
    if (cur.status === 'purged') return c.json({ error: 'already_purged' }, 409);
    if (cur.activeOp === 'purge') return c.json({ error: 'busy' }, 409);
    if (!cur.archivedAt) return c.json({ error: 'not_blocked' }, 409);
    let row: StorageRow | null;
    try {
      row = await restore(c.env, Registry.global(c.env), cur.prefix);
    } catch (e) {
      console.error(`[restore] unblockRepo failed for ${cur.prefix}:`, e);
      return c.json({ error: 'lfs_server_unavailable' }, 502);
    }
    if (!row) return c.json({ error: 'invalid_state' }, 409);
    return c.json({ storage: row });
  })

  // BackUp live R2 → cold storage. Cold-storage only. Runs on any non-purged prefix (blocked or an
  // admin pre-warm of a serving one); 409 if an op is already in flight.
  .post('/:owner/:repo/backup', async (c) => {
    if (!gcConfig(c.env).coldStorage) return c.json({ error: 'cold_storage_disabled' }, 409);
    const cur = c.var.storage;
    if (cur.status === 'purged') return c.json({ error: 'already_purged' }, 409);
    try {
      const id = await startBackup(c.env, { prefix: cur.prefix });
      return c.json({ status: 'backing_up', workflow: id }, 202);
    } catch {
      return c.json({ error: 'busy' }, 409);
    }
  })

  // Cold-storage ops not yet implemented.
  .delete('/:owner/:repo/backup', (c) => c.json({ error: 'not_implemented' }, 501))
  .post('/:owner/:repo/clear', (c) => c.json({ error: 'not_implemented' }, 501))

  // Preview impact + a state-bound token; the token gates the matching POST below.
  .post('/:owner/:repo/purge/preview', purgeable, async (c) => {
    const cur = c.var.storage;
    const present = (await Storage.byPrefix(c.env, cur.prefix).usage()).present;
    return c.json({
      token: await createToken(cur),
      impact: { objects: present.count, bytes: present.size },
    });
  })

  .post('/:owner/:repo/purge', purgeable, async (c) => {
    const cur = c.var.storage;
    if (!(await validateToken(c, cur))) return c.json({ error: 'stale_token' }, 409);
    const { owner, repo } = c.req.param();
    try {
      const id = await startPurge(c.env, {
        prefix: cur.prefix,
        scope: scopeFor(owner, repo),
        triggeredBy: 'admin',
      });
      return c.json({ status: 'purging', workflow: id }, 202);
    } catch {
      // beginOp / create conflict — an op already in flight for this prefix.
      return c.json({ error: 'busy' }, 409);
    }
  })

  // UI analogue of the Slack Confirm button: record the approve, wake the waiting workflow so
  // it deletes now instead of at the deadline.
  .post('/:owner/:repo/workflow/confirm', activePurge, async (c) => {
    const { owner, repo } = c.req.param();
    const scope = scopeFor(owner, repo);
    const by = `admin:${c.var.admin}`;
    const res = await Alerts.global(c.env).decideOrRaise(scope, 'purge', 'approve', by);
    if (!res.ok) return c.json({ error: res.reason }, res.reason === 'not_found' ? 404 : 409);
    await wakePurge(c.env, scope, 'approve', by);
    return c.json({ status: 'confirmed' });
  })

  // Cancel an in-flight Purge. A terminated instance never reaches its `finish` step, so `endOp`
  // must run here to clear `activeOp`; resting status is left unchanged (nothing was deleted).
  .post('/:owner/:repo/workflow/cancel', activePurge, async (c) => {
    const cur = c.var.storage;
    const { owner, repo } = c.req.param();
    const scope = scopeFor(owner, repo);
    // Records the hold and refreshes the Slack message to "cancelled" (best-effort).
    await Alerts.global(c.env).decideOrRaise(scope, 'purge', 'cancel', `admin:${c.var.admin}`);
    const store = Storage.byPrefix(c.env, cur.prefix);
    await store.requestCancel();
    const id = purgeInstanceId(cur.prefix);
    try {
      (await c.env.PURGE_WORKFLOW.get(id)).terminate();
    } catch {
      // workflow already finished/terminated — nothing to stop
    }
    await store.endOp(cur.prefix, id, 'terminated', cur.status);
    return c.json({ status: 'cancelled' });
  });

// The gate admits an admin of *any* configured org, so re-check the caller against this
// `:owner` (cached `orgRole`). Local dev (`api` unset) has full access.
async function requireOwnerAdmin(c: Context<StorageEnv>, next: Next) {
  // StorageEnv only widens AppEnv's Variables; isLocal reads url/env, never `storage`.
  if (isLocal(c as unknown as Context<AppEnv>)) return next();
  if ((await c.var.api.orgRole(c.req.param('owner')!)) !== 'admin')
    return c.json({ error: 'forbidden' }, 403);
  await next();
}

// Resolve the storage row for `:owner/:repo` into `c.var.storage`, or 404.
async function withStorage(c: Context<StorageEnv>, next: Next) {
  const row = await Registry.global(c.env).storageForRepo(
    c.req.param('owner')!,
    c.req.param('repo')!,
  );
  if (!row) return c.json({ error: 'not_found' }, 404);
  c.set('storage', row);
  await next();
}

// Purge gate: cold-storage purge isn't wired yet (501); prefix must be blocked, not yet purged,
// and not still backing a live git repo.
async function purgeable(c: Context<StorageEnv>, next: Next) {
  if (gcConfig(c.env).coldStorage) return c.json({ error: 'not_implemented' }, 501);
  const cur = c.var.storage;
  if (cur.status === 'purged') return c.json({ error: 'already_purged' }, 409);
  if (!cur.archivedAt) return c.json({ error: 'not_blocked' }, 409);
  if (await Registry.global(c.env).storageInUse(cur.prefix))
    return c.json({ error: 'in_use' }, 409);
  await next();
}

// Workflow-control guard: 409 unless a Purge is actually running.
async function activePurge(c: Context<StorageEnv>, next: Next) {
  if (c.var.storage.activeOp !== 'purge') return c.json({ error: 'no_active_op' }, 409);
  await next();
}

async function createToken(storage: StorageRow): Promise<string> {
  return sha256hex(`${storage.prefix}\n${storage.updatedAt}`);
}

// State-bound preview token: goes stale once the row changes (`updatedAt` bumps), so a Purge
// POST can't act on an outdated impact preview. Not an auth boundary.
// True when the request body carries the current confirm token for the row. Bad/missing JSON
// parses to `{}`, so a malformed body fails closed like a stale one.
async function validateToken(c: Context<StorageEnv>, storage: StorageRow): Promise<boolean> {
  const body = await c.req.json<{ token?: string }>().catch(() => ({}) as { token?: string });
  return body.token === (await createToken(storage));
}

export default app;
