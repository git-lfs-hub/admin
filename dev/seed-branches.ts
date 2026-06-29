import { orgsFromEnv } from '@git-lfs-hub/lib/auth';

import { webappSeedOid } from '@dev/mock-github';
import { Repo, type LfsConfig } from '@/db/repo';
import { recomputeBlocks } from '@/server/operations';

// Dev-only: the mock reconcile only ever yields `active` branches, so `acme/webapp` gets one branch
// in each remaining state, spanning both storage-impact cases — `missing` zero-impact (PR churn,
// filtered out), `missing` impactful (reclaimable, badged), `dirty`, and `deleted` (blocked) — so the
// admin drilldown + reclaim rollup are exercisable locally. Runs once after the dev reconcile.
export async function seedBranchShowcase(env: CloudflareBindings): Promise<void> {
  const org = orgsFromEnv(env)[0];
  if (org !== 'acme') return; // fixtures (R2 seed + oids) line up only under the local `acme` org
  const repo = Repo.byRepo(env, org, 'webapp');
  const prefix = `${org}/webapp`;

  // missing, zero-impact — references only shared `logo` (kept live by `main`), so it reclaims
  // nothing: hidden from the default drilldown, never badges (the merged-PR case).
  await seedBranch(env, repo, prefix, 'stale-feature', ['logo']);
  await repo.markBranchMissing('stale-feature');

  // missing, impactful — references `wip-asset` (no active branch holds it) → reclaimable: shown,
  // counted in the rollup, auto-delete countdown running.
  await seedBranch(env, repo, prefix, 'reclaim-me', ['wip-asset']);
  await repo.markBranchMissing('reclaim-me');

  // dirty — tip can't be trusted (force-push not yet resolved); Delete stays disabled until repair.
  await seedBranch(env, repo, prefix, 'wip-draft', ['logo']);
  await repo.markDirty('wip-draft', 'dev-head-webapp/wip-draft');

  // deleted — forfeited; references a unique blob → a real orphan block on the prefix.
  await seedBranch(env, repo, prefix, 'abandoned-fix', ['legacy-blob']);
  await repo.markBranchMissing('abandoned-fix');
  await repo.markBranchDeleted('abandoned-fix');
  try {
    await recomputeBlocks(env, org, 'webapp', prefix);
  } catch (e) {
    // No LFS_SERVER binding (admin running without the server) — branch still shows `deleted`,
    // just without the storage-side block.
    console.error('[dev] seedBranchShowcase recomputeBlocks failed:', e);
  }
}

async function seedBranch(
  env: CloudflareBindings,
  repo: ReturnType<typeof Repo.byRepo>,
  prefix: string,
  branch: string,
  seeds: string[],
): Promise<void> {
  const head = `dev-head-webapp/${branch}`;
  const cfg: LfsConfig = {
    sha: `cfg-${branch}`,
    host: env.LFS.server.toLowerCase(),
    prefix,
    local: true,
    status: 'ok',
  };
  const refs = await Promise.all(
    seeds.map(async (s) => ({ oid: await webappSeedOid(s), path: `${s}.bin` })),
  );
  await repo.recordLfsconfig(branch, head, cfg);
  await repo.setTip(branch, { headSha: head, treeSha: `dev-tree-webapp/${branch}`, gitattrSha: null });
  await repo.replaceRefPaths(branch, refs);
}
