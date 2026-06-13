import { Registry } from '@/db/registry';
import { Storage } from '@/db/storage';
import { autoArchive } from '@/gc/autoArchive';
import { autoPurge } from '@/gc/autoPurge';
import { reconcileObjects } from '@/reconcile/objects';
import { reconcileRepos } from '@/reconcile/repos';
import { discoverRepos } from '@/storage/discovery';

/**
 * Cron pipeline: discover storage prefixes from R2, reconcile git presence + storage link
 * state against GitHub, reconcile each non-purged prefix's object index against R2, then
 * auto-Archive overdue ones, then
 * auto-Purge ones past live retention (wait-only confirmation gate).
 */
export async function reconcileAll(env: CloudflareBindings, local = false): Promise<void> {
  const registry = Registry.global(env);
  await discoverRepos(env.LFS_BUCKET, registry);
  // Local dev has no GitHub App key → fixture stand-in. `__DEV__` is a build-time literal:
  // false in the deployed bundle, so esbuild drops this branch and the `@dev` import with
  // it. Guarded so a failure here never blocks the object pass below.
  try {
    if (__DEV__ && (local || (env.ENV as string) === 'local')) {
      const { reconcileLocal } = await import('@dev/reconcileLocal');
      await reconcileLocal(env, registry);
    } else {
      await reconcileRepos(env, registry);
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
  // Cold-start guard: destructive passes only after a trustworthy full pass certifies the link
  // state — else a stale/failed probe could read every prefix as `unused` and act on live repos.
  if (await registry.getLastFullScanAt()) {
    try {
      await autoArchive(env, registry);
    } catch (e) {
      console.error('[reconcile] auto-archive failed:', e);
    }
    try {
      await autoPurge(env, registry);
    } catch (e) {
      console.error('[reconcile] auto-purge failed:', e);
    }
  }
}
