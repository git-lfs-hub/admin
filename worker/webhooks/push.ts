import { GithubApi, type GithubOrgApi } from '@git-lfs-hub/lib/github';

import { notifyBranchReappeared } from '@/alerts/lifecycle';
import { Repo } from '@/db/repo';
import { applyPushEvent, type BranchPushEvent, type GetApi } from '@/github/branches';
import { scanLfsConfig } from '@/github/lfsconfig';
import { allowedOrgs } from '@/reconcile/repos';

// Push delivers `before`/`after`, `head_commit.tree_id`, `forced`, and per-commit file lists for
// free, so steady state (a sequential push touching no pointer blob) is 0 GitHub calls. Tracks
// every `refs/heads/*`.
export type PushCommit = { added?: string[]; modified?: string[]; removed?: string[] };

export type PushEvent = {
  ref: string;
  before?: string;
  after: string;
  created?: boolean;
  deleted?: boolean;
  forced?: boolean;
  head_commit?: { tree_id?: string } | null;
  repository: { name: string; default_branch: string; owner: { login?: string; name?: string } };
  installation?: { id: number };
  commits?: PushCommit[];
};

export async function handlePushEvent(env: CloudflareBindings, push: PushEvent): Promise<void> {
  const owner = push.repository.owner.login ?? push.repository.owner.name;
  const name = push.repository.name;
  if (!owner || !allowedOrgs(env).has(owner.toLowerCase())) return;
  if (!push.ref.startsWith('refs/heads/')) return; // branches only; tags handled separately
  const branch = push.ref.slice('refs/heads/'.length);

  const repo = Repo.byRepo(env, owner, name);
  let api: GithubOrgApi | null | undefined;
  const getApi: GetApi = async () => {
    if (api === undefined) api = await orgApi(env, owner, push.installation?.id);
    if (!api) throw new Error(`no installation api for ${owner}`);
    return api;
  };

  const prior = await repo.getBranch(branch);

  // A branch admin-confirmed `deleted` stays forfeited regardless of later git events: a re-delete
  // is a no-op, a reappearance only alerts (the block holds) rather than resurrecting the branch.
  if (prior?.status === 'deleted') {
    if (!push.deleted) await notifyBranchReappeared(env, owner, name, branch);
    return;
  }

  if (push.deleted) {
    await repo.markBranchMissing(branch);
    await repo.syncLinks(owner, name);
    return;
  }

  // Branch tip state machine: 0 calls on a sequential push that touched no pointer blob.
  const delta = aggregateFiles(push.commits);
  const branchPush: BranchPushEvent = {
    repo: name,
    branch,
    before: push.before ?? '',
    after: push.after,
    treeSha: push.head_commit?.tree_id ?? null,
    forced: Boolean(push.forced),
    addedModified: delta.addedModified,
    removed: delta.removed,
  };
  try {
    await applyPushEvent(getApi, repo, branchPush);
  } catch (e) {
    console.error(`[push] branch state failed for ${owner}/${name}#${branch}:`, e);
  }

  // Per-branch `.lfsconfig`: scan when the diff touched it or the branch was never scanned (the
  // file may predate this push). `force` because the state machine just advanced the head.
  if (lfsConfigTouched(push) || !prior || prior.lfsconfigStatus == null) {
    try {
      const ref = { owner, repo: name, branch, headSha: push.after };
      await scanLfsConfig(await getApi(), repo, env, ref, true);
    } catch (e) {
      console.error(`[push] lfsconfig scan failed for ${owner}/${name}#${branch}:`, e);
    }
  }
  await repo.syncLinks(owner, name);
}

/** Net file delta across the push's commits (last commit wins for a re-add-after-remove). */
function aggregateFiles(commits?: PushCommit[]): { addedModified: string[]; removed: string[] } {
  const am = new Set<string>();
  const rm = new Set<string>();
  for (const c of commits ?? []) {
    for (const p of [...(c.added ?? []), ...(c.modified ?? [])]) {
      am.add(p);
      rm.delete(p);
    }
    for (const p of c.removed ?? []) {
      rm.add(p);
      am.delete(p);
    }
  }
  return { addedModified: [...am], removed: [...rm] };
}

function lfsConfigTouched(payload: PushEvent): boolean {
  for (const c of payload.commits ?? []) {
    if (
      c.added?.includes('.lfsconfig') ||
      c.modified?.includes('.lfsconfig') ||
      c.removed?.includes('.lfsconfig')
    )
      return true;
  }
  return false;
}

async function orgApi(
  env: CloudflareBindings,
  owner: string,
  installationId: number | undefined,
): Promise<GithubOrgApi | null> {
  if (!installationId) return null;
  const app = await GithubApi.forApp(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
  return app.orgApi({ login: owner, id: installationId });
}
