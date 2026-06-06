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
  // needs storage + the discovered repos). Local dev has no real GitHub App key, so
  // it runs the fixture-driven stand-in (dev/github.ts) instead; both are guarded so
  // a failure never blocks object reconciliation.
  try {
    if (local || (env.ENV as string) === "local") {
      const { reconcileLocal } = await import("@/dev/reconcileLocal");
      await reconcileLocal(env, repos);
    } else {
      await reconcileRepos(env, repos);
    }
  } catch (e) {
    console.error("[reconcile] repo reconciliation failed:", e);
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
