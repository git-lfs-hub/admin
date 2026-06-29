import { GithubError, type GithubOrgApi } from '@git-lfs-hub/lib/github';

import type { Registry } from '@/db/registry';
import { Repo } from '@/db/repo';
import { resolveBranch } from '@/github/branches';
import { scanLfsConfig } from '@/github/lfsconfig';
import { allowedOrgs, githubApp } from '@/reconcile/repos';

// Cron backstop for branch tip tracking. One GraphQL query per repo lists every branch's head +
// root `tree_sha`; a branch is re-resolved only when new / `dirty` / its `tree_sha` drifted — so
// steady state (webhooks current) is 0 tree calls. The real-time path is the `push` webhook.

/** Stop the sweep when GraphQL points run low; `dirty`/mismatch persist, so next tick resumes. */
const RATE_FLOOR = 200;

export type ReconcileBranchesResult = {
  repos: number;
  resolved: number;
  missing: number;
  stopped: boolean; // true when rate-limit backoff cut the sweep short
};

export async function reconcileBranches(
  env: CloudflareBindings,
  registry: DurableObjectStub<Registry>,
  local = false,
): Promise<ReconcileBranchesResult> {
  const app = await githubApp(env, local);
  const allow = allowedOrgs(env);
  const accounts = (await app.installedOrgs()).filter((a) => allow.has(a.login.toLowerCase()));
  const reposByOwner = activeReposByOwner(await registry.listRepos());

  const out: ReconcileBranchesResult = { repos: 0, resolved: 0, missing: 0, stopped: false };
  for (const account of accounts) {
    const owner = account.login.toLowerCase();
    const names = reposByOwner.get(owner);
    if (!names?.length) continue;
    let api: GithubOrgApi;
    try {
      api = await app.orgApi(account);
    } catch (e) {
      console.error(`[reconcile] branch orgApi failed for ${owner}:`, e);
      continue;
    }
    for (const name of names) {
      out.repos++;
      try {
        const r = await reconcileRepoBranches(api, env, owner, name);
        out.resolved += r.resolved;
        out.missing += r.missing;
        if (r.rateLow) return { ...out, stopped: true };
      } catch (e) {
        if (e instanceof GithubError && e.code === 'rate_limited') return { ...out, stopped: true };
        console.error(`[reconcile] branch reconcile failed for ${owner}/${name}:`, e);
      }
    }
  }
  return out;
}

/** On-demand single-repo branch resolve — confirm-delete's resolve-then-block. Refreshes the
 *  repo's `branches`/`ref_paths` from GitHub so the block set is computed on a current graph.
 *  Throws on no installation / GitHub failure (the route maps that to a retriable 502). */
export async function resolveRepoBranches(
  env: CloudflareBindings,
  owner: string,
  name: string,
  local = false,
): Promise<void> {
  const app = await githubApp(env, local);
  const account = (await app.installedOrgs()).find(
    (a) => a.login.toLowerCase() === owner.toLowerCase(),
  );
  if (!account) throw new Error(`no GitHub installation for ${owner}`);
  await reconcileRepoBranches(await app.orgApi(account), env, owner, name);
}

/** One repo: GraphQL all-branches vs stored `branches`; resolve the drifted ones, mark vanished
 *  ones `missing`, one `syncLinks` if anything changed. */
async function reconcileRepoBranches(
  api: GithubOrgApi,
  env: CloudflareBindings,
  owner: string,
  name: string,
): Promise<{ resolved: number; missing: number; rateLow: boolean }> {
  const repo = Repo.byRepo(env, owner, name);
  const { branches: live, rateLimit } = await api.listBranches(name);
  const stored = await repo.listBranches();
  const byName = new Map(stored.map((b) => [b.branch, b]));
  const seen = new Set<string>();

  let resolved = 0;
  let changed = false;
  for (const gh of live) {
    seen.add(gh.branch);
    const prior = byName.get(gh.branch);
    if (prior?.status === 'missing') await repo.markBranchActive(gh.branch); // reappeared
    if (prior && !prior.dirty && prior.treeSha === gh.treeSha) continue; // current → 0 calls
    const ref = { owner, repo: name, branch: gh.branch, headSha: gh.headSha };
    await scanLfsConfig(api, repo, env, ref, true); // tree drifted ⇒ `.lfsconfig` may have
    const o = await resolveBranch(api, repo, gh.branch, {
      headSha: gh.headSha,
      treeSha: gh.treeSha,
    });
    if (o === 'resolved' || o === 'copied') resolved++;
    changed = true;
  }

  let missing = 0;
  for (const b of stored) {
    if (seen.has(b.branch) || b.status !== 'active') continue; // gone from GitHub → forfeit
    await repo.markBranchMissing(b.branch);
    missing++;
    changed = true;
  }

  if (changed) await repo.syncLinks(owner, name);
  return { resolved, missing, rateLow: rateLimit ? rateLimit.remaining < RATE_FLOOR : false };
}

function activeReposByOwner(
  rows: { owner: string; repo: string; status: string }[],
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const r of rows) {
    if (r.status !== 'active') continue;
    (out.get(r.owner) ?? out.set(r.owner, []).get(r.owner)!).push(r.repo);
  }
  return out;
}
