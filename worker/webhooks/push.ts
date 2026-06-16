import { GithubApi, type GithubOrgApi } from '@git-lfs-hub/lib/github';

import { Repo } from '@/db/repo';
import { scanLfsconfig } from '@/github/lfsconfig';
import { allowedOrgs } from '@/reconcile/repos';

// Push delivers the changed-file list for free, so steady state (no `.lfsconfig` edits) is 0
// GitHub calls. This phase scans the default branch only; other branches land in Phase 2.
export type PushEvent = {
  ref: string;
  after: string;
  repository: { name: string; default_branch: string; owner: { login?: string; name?: string } };
  installation?: { id: number };
  commits?: { added?: string[]; modified?: string[]; removed?: string[] }[];
};

const LFSCONFIG = '.lfsconfig';

export async function handlePush(env: CloudflareBindings, payload: PushEvent): Promise<void> {
  const owner = payload.repository.owner.login ?? payload.repository.owner.name;
  const name = payload.repository.name;
  if (!owner || !allowedOrgs(env).has(owner.toLowerCase())) return;

  const branch = payload.repository.default_branch;
  if (payload.ref !== `refs/heads/${branch}`) return;

  const repo = Repo.byRepo(env, owner, name);
  const headSha = payload.after;
  const ref = { owner, name, branch, headSha };

  // Scan when the push touched `.lfsconfig` or the repo was never scanned (the file may predate
  // this push); otherwise just advance the head — the parse still holds, 0 GitHub calls.
  if (lfsconfigTouched(payload) || (await repo.getBranch(branch)) === null) {
    const api = await orgApi(env, owner, payload.installation?.id);
    if (!api) return;
    await scanLfsconfig(api, repo, env, ref);
  } else {
    await repo.recordHead(branch, headSha);
  }
  await repo.syncLinks(owner, name);
}

function lfsconfigTouched(payload: PushEvent): boolean {
  for (const c of payload.commits ?? []) {
    if (c.added?.includes(LFSCONFIG) || c.modified?.includes(LFSCONFIG) || c.removed?.includes(LFSCONFIG))
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
