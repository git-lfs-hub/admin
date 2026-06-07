import { autoArchive } from '@/gc/autoArchive';
import { reconcileObjects } from '@/reconcile/objects';
import { reconcileRepos } from '@/reconcile/repos';
import { discoverRepos } from '@/storage/discovery';

/**
 * Cron pipeline: discover repos from storage, reconcile them against GitHub, reconcile
 * each non-purged repo's object index against storage, then auto-Archive overdue ones.
 */
export async function reconcileAll(env: CloudflareBindings, local = false): Promise<void> {
  const repos = env.REPOS.getByName('global');
  await discoverRepos(env.LFS_BUCKET, repos);
  // Local dev has no GitHub App key → fixture stand-in. `__DEV__` is a build-time literal:
  // false in the deployed bundle, so esbuild drops this branch and the `@dev` import with
  // it. Guarded so a failure here never blocks the object pass below.
  try {
    if (__DEV__ && (local || (env.ENV as string) === 'local')) {
      const { reconcileLocal } = await import('@dev/reconcileLocal');
      await reconcileLocal(env, repos);
    } else {
      await reconcileRepos(env, repos);
    }
  } catch (e) {
    console.error('[reconcile] repo reconciliation failed:', e);
  }
  for (const row of await repos.listAll()) {
    if (row.status === 'purged') continue;
    const repo = env.REPO.getByName(row.name);
    try {
      await reconcileObjects(env.LFS_BUCKET, repo, `${row.name}/`);
    } catch (e) {
      console.error(`[reconcile] object reconciliation failed for ${row.name}:`, e);
    }
  }
  try {
    await autoArchive(env, repos);
  } catch (e) {
    console.error('[reconcile] auto-archive failed:', e);
  }
}
