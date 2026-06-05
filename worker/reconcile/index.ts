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
  await reconcileRepos(env, repos);
  for (const r of await repos.listAll()) {
    if (r.status === "purged") continue;
    const index = env.INDEX.get(env.INDEX.idFromName(r.storagePrefix.slice(0, -1)));
    await reconcileObjects(env.LFS_BUCKET, index, r.storagePrefix);
  }
}
