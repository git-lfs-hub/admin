import { devPresentRepos } from '@dev/github';

import type { Registry } from '@/db/registry';
import { applyReconciliation } from '@/reconcile/repos';

/** GitHub reconcile stand-in for local dev: the `devPresentRepos` fixture is "what's on
 *  GitHub", and its owners are the reachable installations. `present` is injectable for tests. */
export async function reconcileLocal(
  env: CloudflareBindings,
  registry: DurableObjectStub<Registry>,
  present: string[] = devPresentRepos,
): Promise<boolean> {
  const activeRepos = new Set(present.map((r) => r.toLowerCase()));
  const activeOrgs = new Set([...activeRepos].map((r) => r.split('/')[0]));
  await seedDevLinks(registry, activeRepos);
  await applyReconciliation(env, registry, activeOrgs, activeRepos);
  // The fixture is authoritative (every owner reachable) → always a full scan; else the
  // cold-start guard would permanently disable auto-Archive in dev.
  return true;
}

// No `.lfsconfig` scan locally (no GitHub App key), so `links` would stay empty and every prefix
// reads `unused`. Seed the 1:1 git↔prefix link the scan would produce — a prefix whose path matches
// a present repo links to it — before reconcile reads link state (mirrors Phase 1 same-key in dev).
async function seedDevLinks(
  registry: DurableObjectStub<Registry>,
  activeRepos: Set<string>,
): Promise<void> {
  const prefixesByRepo = new Map<string, Set<string>>();
  for (const row of await registry.listStorage()) {
    const key = row.prefix.toLowerCase();
    if (!activeRepos.has(key)) continue;
    (prefixesByRepo.get(key) ?? prefixesByRepo.set(key, new Set()).get(key)!).add(row.prefix);
  }
  for (const [key, prefixes] of prefixesByRepo) {
    const [owner, repo] = key.split('/');
    await registry.syncLinks(owner, repo, prefixes);
  }
}
