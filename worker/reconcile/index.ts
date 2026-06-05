import { discoverRepos } from "@/storage/discovery";
import { reconcileRepos } from "@/reconcile/repos";
import { reconcileObjects } from "@/reconcile/objects";

/**
 * Cron pipeline: discover repos from storage, reconcile them against GitHub,
 * then reconcile each non-purged repo's object index against storage.
 */
export async function reconcileAll(env: CloudflareBindings): Promise<void> {
  const repos = env.REPOS.get(env.REPOS.idFromName("global"));
  await discoverRepos(env.LFS_BUCKET, repos);
  // GitHub repo reconciliation is independent of the object pass below (which only
  // needs storage + the discovered repos). Don't let a GitHub failure — e.g. missing
  // app creds in dev — block object reconciliation.
  try {
    await reconcileRepos(env, repos);
  } catch (e) {
    console.error("[reconcile] repo reconciliation failed:", e);
  }
  for (const r of await repos.listAll()) {
    if (r.status === "purged") continue;
    const index = env.INDEX.get(env.INDEX.idFromName(r.name));
    await reconcileObjects(env.LFS_BUCKET, index, `${r.name}/`);
  }
}
