import { Registry } from '@/db/registry';
import { Storage } from '@/db/storage';
import { autoArchive } from '@/gc/autoArchive';
import { autoBackup } from '@/gc/autoBackup';
import { autoClear } from '@/gc/autoClear';
import { autoPurge } from '@/gc/autoPurge';
import { reconcileObjects } from '@/reconcile/objects';
import { reconcileRepos } from '@/reconcile/repos';
import { reconcileWorkflows } from '@/reconcile/workflows';
import { discoverRepos } from '@/storage/discovery';

/**
 * Cron pipeline: discover storage prefixes from R2, reconcile git presence + storage link
 * state against GitHub, reconcile each non-purged prefix's object index against R2, then
 * auto-Archive overdue ones, auto-BackUp freshly-blocked ones (cold storage), auto-Clear
 * backed-up ones past the clear window, then auto-Purge ones past retention (wait-only gate).
 */
export async function reconcileAll(env: CloudflareBindings, local = false): Promise<void> {
  const registry = Registry.global(env);
  await discoverRepos(env.LFS_BUCKET, registry);
  // Guarded: a repo-reconcile failure must not block the object pass below.
  let fullScan = false;
  try {
    fullScan = (await reconcileRepos(env, registry, local)).fullScan;
  } catch (e) {
    console.error('[reconcile] repo reconciliation failed:', e);
  }
  for (const row of await registry.listStorage()) {
    if (row.status === 'purged') continue;
    const store = Storage.byPrefix(env, row.prefix);
    try {
      await reconcileObjects(env.LFS_BUCKET, store, `${row.prefix}/`);
    } catch (e) {
      console.error(`[reconcile] object reconciliation failed for ${row.prefix}:`, e);
    }
  }
  // Non-destructive, so it runs outside the `fullScan` guard below — every tick, to unwedge the UI
  // promptly even after a partial scan.
  try {
    await reconcileWorkflows(env, registry);
  } catch (e) {
    console.error('[reconcile] workflow reconciliation failed:', e);
  }
  // Cold-start guard: destructive passes only after a full scan this tick — else a partial/failed
  // probe could read every prefix as `unused` and act on live repos.
  if (fullScan) {
    try {
      await autoArchive(env, registry);
    } catch (e) {
      console.error('[reconcile] auto-archive failed:', e);
    }
    // Back up freshly-blocked prefixes to cold storage (no-op off the cold-storage path).
    try {
      await autoBackup(env, registry);
    } catch (e) {
      console.error('[reconcile] auto-backup failed:', e);
    }
    // Clear live R2 for backed-up prefixes past the clear window (cold storage only, gated).
    try {
      await autoClear(env, registry);
    } catch (e) {
      console.error('[reconcile] auto-clear failed:', e);
    }
    try {
      await autoPurge(env, registry);
    } catch (e) {
      console.error('[reconcile] auto-purge failed:', e);
    }
  }
}
