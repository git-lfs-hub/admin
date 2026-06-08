import { devPresentRepos } from '@dev/github';

import type { Registry } from '@/db/registry';
import { applyReconciliation } from '@/reconcile/repos';

/** GitHub reconcile stand-in for local dev: treats every discovered owner as reachable
 *  and the `devPresentRepos` fixture as the org listing. `present` is injectable for tests. */
export async function reconcileLocal(
  env: CloudflareBindings,
  registry: DurableObjectStub<Registry>,
  present: string[] = devPresentRepos,
): Promise<void> {
  const activeOrgs = new Set(await registry.listOwners());
  const activeRepos = new Set(present.map((r) => r.toLowerCase()));
  await applyReconciliation(env, registry, activeOrgs, activeRepos);
  // The fixture is authoritative (every owner reachable), so certify the pass — else the
  // cold-start guard would permanently disable auto-Archive in dev.
  await registry.markFullScan();
}
