import { devPresentRepos, devLinks } from '@dev/github';

import type { Registry } from '@/db/registry';
import { applyReconciliation } from '@/reconcile/repos';

/** GitHub reconcile stand-in for local dev: the `devPresentRepos` fixture is "what's on
 *  GitHub", and its owners are the reachable installations. `present`/`links` are injectable
 *  for tests. */
export async function reconcileLocal(
  env: CloudflareBindings,
  registry: DurableObjectStub<Registry>,
  present: string[] = devPresentRepos,
  links: Record<string, string[]> = devLinks,
): Promise<boolean> {
  const activeRepos = new Set(present.map((r) => r.toLowerCase()));
  const activeOrgs = new Set([...activeRepos].map((r) => r.split('/')[0]));
  await seedDevLinks(registry, activeRepos, links);
  await applyReconciliation(env, registry, activeOrgs, activeRepos);
  // The fixture is authoritative (every owner reachable) → always a full scan; else the
  // cold-start guard would permanently disable auto-Archive in dev.
  return true;
}

// No `.lfsconfig` scan locally (no GitHub App key), so `links` would stay empty and every prefix
// reads `unused`. Seed the graph the scan would produce before reconcile reads link state: the
// explicit `devLinks` mapping for the fixture repos (N:N + mismatched names, creating the storage
// rows it points at), then a same-key fallback for any other present repo backed by an R2 prefix
// (mirrors Phase 1 same-key in dev).
async function seedDevLinks(
  registry: DurableObjectStub<Registry>,
  activeRepos: Set<string>,
  links: Record<string, string[]>,
): Promise<void> {
  const mapped = new Set<string>();
  for (const [key, prefixes] of Object.entries(links)) {
    if (!activeRepos.has(key)) continue;
    for (const prefix of prefixes) await registry.upsertStorage(prefix);
    const [owner, repo] = key.split('/');
    await registry.syncLinks(owner, repo, new Set(prefixes));
    mapped.add(key);
  }

  const prefixesByRepo = new Map<string, Set<string>>();
  for (const row of await registry.listStorage()) {
    const key = row.prefix.toLowerCase();
    if (!activeRepos.has(key) || mapped.has(key)) continue;
    (prefixesByRepo.get(key) ?? prefixesByRepo.set(key, new Set()).get(key)!).add(row.prefix);
  }
  for (const [key, prefixes] of prefixesByRepo) {
    const [owner, repo] = key.split('/');
    await registry.syncLinks(owner, repo, prefixes);
  }
}
