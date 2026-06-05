import { discoverRepos } from "@/storage/discovery";
import { reconcileRepos } from "@/reconcile/repos";
import { reconcileObjects } from "@/reconcile/objects";

/**
 * Cron pipeline: discover repos from storage, reconcile them against GitHub,
 * then reconcile each non-purged repo's object index against storage.
 */
export async function reconcileAll(env: CloudflareBindings, local = false): Promise<void> {
  const repos = env.REPOS.getByName("global");
  await discoverRepos(env.LFS_BUCKET, repos);
  // GitHub repo reconciliation is independent of the object pass below (which only
  // needs storage + the discovered repos). Skipped in local dev (no real GitHub App
  // key); also guarded so a GitHub failure never blocks object reconciliation.
  if (local || (env.ENV as string) === "local") {
    console.warn("[reconcile] local mode: skipping GitHub repo reconciliation");
  } else {
    try {
      await reconcileRepos(env, repos);
    } catch (e) {
      console.error("[reconcile] repo reconciliation failed:", e);
    }
  }
  for (const row of await repos.listAll()) {
    if (row.status === "purged") continue;
    const repo = env.REPO.getByName(row.name);
    try {
      await reconcileObjects(env.LFS_BUCKET, repo, `${row.name}/`);
    } catch (e) {
      console.error(`[reconcile] object reconciliation failed for ${row.name}:`, e);
    }
  }
}
