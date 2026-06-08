import { devPresentRepos } from '@dev/github';

import type { Registry } from '@/db/registry';
import { applyReconciliation } from '@/reconcile/repos';

/** GitHub reconcile stand-in for local dev: the `devPresentRepos` fixture is "what's on
 *  GitHub", and its owners are the reachable installations. `present` is injectable for tests. */
export async function reconcileLocal(
  env: CloudflareBindings,
  registry: DurableObjectStub<Registry>,
  present: string[] = devPresentRepos,
): Promise<void> {
  const activeRepos = new Set(present.map((r) => r.toLowerCase()));
  const activeOrgs = new Set([...activeRepos].map((r) => r.split('/')[0]));
  await applyReconciliation(env, registry, activeOrgs, activeRepos);
  // The fixture is authoritative (every owner reachable), so certify the pass — else the
  // cold-start guard would permanently disable auto-Archive in dev.
  await registry.markFullScan();
}
