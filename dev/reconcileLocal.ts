import type { Repos } from "@/db/repos";
import { applyReconciliation } from "@/reconcile/repos";
import { devPresentRepos } from "@dev/github";

/** GitHub reconcile stand-in for local dev: treats every discovered owner as reachable
 *  and the `devPresentRepos` fixture as the org listing. `present` is injectable for tests. */
export async function reconcileLocal(
  env: CloudflareBindings,
  repos: DurableObjectStub<Repos>,
  present: string[] = devPresentRepos,
): Promise<void> {
  const activeOrgs = new Set(await repos.listOwners());
  const activeRepos = new Set(present.map((r) => r.toLowerCase()));
  await applyReconciliation(env, repos, activeOrgs, activeRepos);
}
