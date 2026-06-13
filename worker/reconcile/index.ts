import { Registry } from '@/db/registry';
import { Storage } from '@/db/storage';
import { autoArchive } from '@/gc/autoArchive';
import { autoBackup } from '@/gc/autoBackup';
import { autoPurge } from '@/gc/autoPurge';
import { reconcileObjects } from '@/reconcile/objects';
import { reconcileRepos } from '@/reconcile/repos';
import { discoverRepos } from '@/storage/discovery';

/**
 * Cron pipeline: discover storage prefixes from R2, reconcile git presence + storage link
 * state against GitHub, reconcile each non-purged prefix's object index against R2, then
 * auto-Archive overdue ones, auto-BackUp freshly-blocked ones (cold storage), then
 * auto-Purge ones past live retention (wait-only confirmation gate).
 */
export async function reconcileAll(env: CloudflareBindings, local = false): Promise<void> {
  const registry = Registry.global(env);
  await discoverRepos(env.LFS_BUCKET, registry);
  // Local dev has no GitHub App key → fixture stand-in. `__DEV__` is a build-time literal:
  // false in the deployed bundle, so esbuild drops this branch and the `@dev` import with
  // it. Guarded so a failure here never blocks the object pass below.
  let fullScan = false;
  try {
    if (__DEV__ && (local || (env.ENV as string) === 'local')) {
      const { reconcileLocal } = await import('@dev/reconcileLocal');
      fullScan = await reconcileLocal(env, registry);
    } else {
      fullScan = (await reconcileRepos(env, registry)).fullScan;
    }
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
    try {
      await autoPurge(env, registry);
    } catch (e) {
      console.error('[reconcile] auto-purge failed:', e);
    }
  }
}
