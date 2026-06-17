import { devPresentRepos, devLinks } from '@dev/github';
import type { RepoScan } from '@git-lfs-hub/lib/github';

import type { Registry } from '@/db/registry';
import { syncLfsconfigs } from '@/reconcile/lfsconfig';
import { applyReconciliation } from '@/reconcile/repos';

/** GitHub reconcile stand-in for local dev (no GitHub App key): `devPresentRepos` is "what's on
 *  GitHub", its owners are the reachable installations, and `devLinks` is each repo's committed
 *  `.lfsconfig`. We fabricate the same `RepoScan[]` the GraphQL sweep returns and run it through
 *  the real `syncLfsconfigs` path, so the REPO DO is populated exactly as in prod — branches +
 *  lfsconfigs recorded, links projected onto REGISTRY via `Repo.syncLinks`. `present`/`links` are
 *  injectable for tests. */
export async function reconcileLocal(
  env: CloudflareBindings,
  registry: DurableObjectStub<Registry>,
  present: string[] = devPresentRepos,
  links: Record<string, string> = devLinks,
): Promise<boolean> {
  const activeRepos = new Set(present.map((r) => r.toLowerCase()));
  const activeOrgs = new Set([...activeRepos].map((r) => r.split('/')[0]));
  // Scan first so the links exist before `reconcileStorage` reads them: dev fires reconcile once
  // per worker load (no cron), so one tick must equal prod's converged state, not its cold start.
  await syncLfsconfigs(env, devScans(env, present, links));
  await applyReconciliation(env, registry, activeOrgs, activeRepos);
  // The fixture is authoritative (every owner reachable) → always a full scan; else the cold-start
  // guard would permanently disable auto-Archive in dev.
  return true;
}

/** Fabricate the sweep's `RepoScan[]`: each present repo on `main`, with a committed `.lfsconfig`
 *  pointing at this deployment's LFS server (so it parses `local`/`ok`) when `links` maps it, or no
 *  `.lfsconfig` (→ no link, prefix `unused`) when it doesn't. */
export function devScans(
  env: CloudflareBindings,
  present: string[],
  links: Record<string, string>,
): RepoScan[] {
  return present.map((key) => {
    const lc = key.toLowerCase();
    const [owner, name] = lc.split('/');
    const prefix = links[lc] ?? null;
    return {
      owner,
      name,
      branch: 'main',
      headSha: `dev-head-${lc}`,
      lfsconfig: prefix ? { oid: `dev-oid-${prefix}`, text: devLfsconfig(env, prefix) } : null,
    };
  });
}

/** A committed `.lfsconfig` whose `lfs.url` targets this deployment's LFS server for `prefix` — so
 *  the scan parses it `local` and `ok`, the same shape `lfsPrefixFromPath` extracts in prod. */
function devLfsconfig(env: CloudflareBindings, prefix: string): string {
  return `[lfs]\n\turl = https://${env.LFS.server}/lfs/${prefix}\n`;
}
