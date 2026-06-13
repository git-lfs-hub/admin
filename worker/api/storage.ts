import { sha256hex } from '@git-lfs-hub/lib/crypto';
import { Hono, type Context, type Next } from 'hono';

import type { AppEnv } from '@/_env';
import { scopeFor } from '@/alerts/message';
import { Alerts } from '@/db/alerts';
import { Registry, type StorageRow } from '@/db/registry';
import { Storage } from '@/db/storage';
import { gcConfig } from '@/gc/config';
import { dueAt, purgeConfirmDueAt } from '@/gc/deadlines';
import { isLocal } from '@/lib/host';
import { archive, restore } from '@/server/operations';
import { wakeConfirmation } from '@/workflows/confirm';
import { startWorkflow, terminateWorkflow } from '@/workflows/lifecycle';

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
          willArchiveAt: dueAt.archive(row, gc),
          willPurgeAt: dueAt.purge(row, gc),
          purgeConfirmBy: purgeConfirmDueAt(row, gc),
        };
      }),
    );
    return c.json({ storage: result });
  })

  // Guard before lookup so cross-owner writes 403 before resolving. GET `/` above stays global.
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

  // Clear the serve-block. Status untouched — link state is reconcile's call. Live present →
  // inline `unblockRepo` (RPC before DB write). Live cleared → durable Glacier retrieval.
  .post('/:owner/:repo/restore', async (c) => {
    const cur = c.var.storage;
    // Purged/mid-purge neither serves, so unblocking is meaningless. Gate before the block check
    // (a purged row keeps its `archivedAt`).
    if (cur.status === 'purged') return c.json({ error: 'already_purged' }, 409);
    if (cur.activeOp === 'purge') return c.json({ error: 'busy' }, 409);
    if (!cur.archivedAt) return c.json({ error: 'not_blocked' }, 409);

    // Cold path: live was cleared → durable Glacier retrieval, repo stays blocked until it lands.
    if (cur.clearedAt) {
      if (cur.activeOp) return c.json({ error: 'busy' }, 409);
      try {
        const id = await startWorkflow(c.env, 'restore', {
          prefix: cur.prefix,
        });
        return c.json({ status: 'restoring', workflow: id }, 202);
      } catch {
        return c.json({ error: 'busy' }, 409);
      }
    }

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

  // Back up live R2 → cold storage. Cold-storage only; any non-purged prefix; 409 if an op is
  // already in flight.
  .post('/:owner/:repo/backup', async (c) => {
    if (!gcConfig(c.env).coldStorage) return c.json({ error: 'cold_storage_disabled' }, 409);
    const cur = c.var.storage;
    if (cur.status === 'purged') return c.json({ error: 'already_purged' }, 409);
    try {
      const id = await startWorkflow(c.env, 'backup', {
        prefix: cur.prefix,
      });
      return c.json({ status: 'backing_up', workflow: id }, 202);
    } catch {
      return c.json({ error: 'busy' }, 409);
    }
  })

  // Delete the cold copy, leaving live R2. Cold-storage only; 409 unless a cold copy exists and
  // live is still present (once cleared the cold copy is the only copy).
  .delete('/:owner/:repo/backup', async (c) => {
    if (!gcConfig(c.env).coldStorage) return c.json({ error: 'cold_storage_disabled' }, 409);
    const cur = c.var.storage;
    if (!cur.backedUpAt) return c.json({ error: 'no_backup' }, 409);
    if (cur.clearedAt) return c.json({ error: 'cleared' }, 409);
    try {
      const id = await startWorkflow(c.env, 'deleteBackup', {
        prefix: cur.prefix,
      });
      return c.json({ status: 'deleting_backup', workflow: id }, 202);
    } catch {
      return c.json({ error: 'busy' }, 409);
    }
  })

  // Clear live R2, keep the cold copy. Cold-storage only; gated on a complete backup, still blocked,
  // not already cleared/purged. Stays blocked; Restore brings live back from cold.
  .post('/:owner/:repo/clear', async (c) => {
    if (!gcConfig(c.env).coldStorage) return c.json({ error: 'cold_storage_disabled' }, 409);
    const cur = c.var.storage;
    if (cur.status === 'purged') return c.json({ error: 'already_purged' }, 409);
    if (!cur.archivedAt) return c.json({ error: 'not_blocked' }, 409);
    if (!cur.backupComplete) return c.json({ error: 'not_backed_up' }, 409);
    if (cur.clearedAt) return c.json({ error: 'already_cleared' }, 409);
    try {
      const id = await startWorkflow(c.env, 'clear', { prefix: cur.prefix });
      return c.json({ status: 'clearing', workflow: id }, 202);
    } catch {
      return c.json({ error: 'busy' }, 409);
    }
  })

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
      const id = await startWorkflow(c.env, 'purge', {
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
    const res = await Alerts.global(c.env).recordDecision(scope, 'purge', 'approve', by);
    if (!res.ok) return c.json({ error: res.reason }, res.reason === 'not_found' ? 404 : 409);
    await wakeConfirmation(c.env, scope, 'purge', 'approve', by);
    return c.json({ status: 'confirmed' });
  })

  // Cancel an in-flight Purge. A terminated instance never reaches its `finish` step, so `endOp`
  // must run here to clear `activeOp`; resting status is left unchanged (nothing was deleted).
  .post('/:owner/:repo/workflow/cancel', activePurge, async (c) => {
    const cur = c.var.storage;
    const { owner, repo } = c.req.param();
    const scope = scopeFor(owner, repo);
    // Audit who cancelled + flip the Slack message to "cancelled" (chat.update in place). The run
    // itself is stopped below by terminate(); this is only the human-facing/audit side.
    await Alerts.global(c.env).recordDecision(scope, 'purge', 'cancel', `admin:${c.var.admin}`);
    await terminateWorkflow(c.env, 'purge', cur.prefix, cur.status);
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

// Purge gate (both cold and no-cold paths): prefix must be blocked, not yet purged, and not still
// backing a live git repo. The workflow drops the cold copy when cold storage is on.
async function purgeable(c: Context<StorageEnv>, next: Next) {
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
