import type { Repos } from "@/db/repos";
import { applyReconciliation } from "@/reconcile/repos";
import { presentRepos } from "@/dev/github";

/**
 * Local-dev stand-in for GitHub reconciliation (no GitHub App key locally). Every
 * discovered owner is treated as reachable; repos absent from the `presentRepos`
 * fixture are treated as gone → `missing` (reappearance handled the same as prod).
 * `present` is injectable for tests; defaults to the committed fixture.
 */
export async function reconcileLocal(
  env: CloudflareBindings,
  repos: DurableObjectStub<Repos>,
  present: string[] = presentRepos,
): Promise<void> {
  const activeOrgs = new Set(await repos.listOwners());
  const activeRepos = new Set(present.map((r) => r.toLowerCase()));
  await applyReconciliation(env, repos, activeOrgs, activeRepos);
}
