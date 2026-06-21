import { GithubError } from '@git-lfs-hub/lib/github';
import { test, expect, vi, beforeEach, describe } from 'vitest';

const resolveBranch = vi.fn(async (..._a: unknown[]) => 'resolved');
vi.mock('@/github/branches', () => ({ resolveBranch: (...a: unknown[]) => resolveBranch(...a) }));

const scanLfsConfig = vi.fn(async (..._a: unknown[]) => 'ok');
vi.mock('@/github/lfsconfig', () => ({ scanLfsConfig: (...a: unknown[]) => scanLfsConfig(...a) }));

const listBranches = vi.fn(async (..._a: unknown[]) => ({}) as any);
const orgApi = vi.fn(async () => ({ listBranches }));
const installedOrgs = vi.fn(async () => [{ login: 'Acme', id: 1 }]);
const githubApp = vi.fn(async (..._a: unknown[]) => ({ installedOrgs, orgApi }));
vi.mock('@/reconcile/repos', () => ({
  githubApp: (...a: unknown[]) => githubApp(...a),
  allowedOrgs: () => new Set(['acme']),
}));

const repoBranches = vi.fn(async (): Promise<unknown[]> => []);
const markBranchActive = vi.fn(async () => {});
const markBranchMissing = vi.fn(async () => {});
const syncLinks = vi.fn(async () => {});
const repoStub = {
  listBranches: repoBranches,
  markBranchActive,
  markBranchMissing,
  syncLinks,
};
vi.mock('@/db/repo', () => ({ Repo: { byRepo: () => repoStub } }));

import { reconcileBranches } from '@/reconcile/branches';

const env = {} as any;
const registry = {
  listRepos: vi.fn(async () => [{ owner: 'acme', repo: 'webapp', status: 'active' }]),
} as any;

const gh = (branch: string, treeSha: string, remaining = 5000) => ({
  branches: [{ branch, headSha: `h-${branch}`, treeSha }],
  rateLimit: { remaining, resetAt: 'z' },
});

beforeEach(() => {
  vi.clearAllMocks();
  repoBranches.mockResolvedValue([]);
});

describe('reconcileBranches', () => {
  test('new branch → scanLfsConfig + resolveBranch, then syncLinks', async () => {
    listBranches.mockResolvedValue(gh('main', 't1'));
    const out = await reconcileBranches(env, registry);
    expect(scanLfsConfig).toHaveBeenCalledTimes(1);
    expect(resolveBranch).toHaveBeenCalledWith(expect.anything(), repoStub, 'main', {
      headSha: 'h-main',
      treeSha: 't1',
    });
    expect(syncLinks).toHaveBeenCalledWith('acme', 'webapp');
    expect(out).toMatchObject({ repos: 1, resolved: 1, missing: 0, stopped: false });
  });

  test('tree_sha unchanged + clean → no resolve, no syncLinks (0 calls)', async () => {
    repoBranches.mockResolvedValue([
      { branch: 'main', treeSha: 't1', dirty: false, status: 'active' },
    ]);
    listBranches.mockResolvedValue(gh('main', 't1'));
    const out = await reconcileBranches(env, registry);
    expect(resolveBranch).not.toHaveBeenCalled();
    expect(syncLinks).not.toHaveBeenCalled();
    expect(out.resolved).toBe(0);
  });

  test('dirty branch is re-resolved even at the same tree_sha', async () => {
    repoBranches.mockResolvedValue([
      { branch: 'main', treeSha: 't1', dirty: true, status: 'active' },
    ]);
    listBranches.mockResolvedValue(gh('main', 't1'));
    await reconcileBranches(env, registry);
    expect(resolveBranch).toHaveBeenCalledTimes(1);
  });

  test('branch gone from GitHub → markBranchMissing', async () => {
    repoBranches.mockResolvedValue([
      { branch: 'old', treeSha: 't0', dirty: false, status: 'active' },
    ]);
    listBranches.mockResolvedValue(gh('main', 't1'));
    const out = await reconcileBranches(env, registry);
    expect(markBranchMissing).toHaveBeenCalledWith('old');
    expect(out.missing).toBe(1);
  });

  test('reappeared (missing → active) branch flips active', async () => {
    repoBranches.mockResolvedValue([
      { branch: 'main', treeSha: 't1', dirty: false, status: 'missing' },
    ]);
    listBranches.mockResolvedValue(gh('main', 't1'));
    await reconcileBranches(env, registry);
    expect(markBranchActive).toHaveBeenCalledWith('main');
  });

  test('rate-limit floor stops the sweep', async () => {
    listBranches.mockResolvedValue(gh('main', 't1', 10)); // below RATE_FLOOR
    const out = await reconcileBranches(env, registry);
    expect(out.stopped).toBe(true);
  });

  test('a sibling-copy resolve counts toward resolved', async () => {
    resolveBranch.mockResolvedValueOnce('copied');
    listBranches.mockResolvedValue(gh('main', 't1'));
    const out = await reconcileBranches(env, registry);
    expect(out.resolved).toBe(1);
  });

  test('non-active repos are skipped', async () => {
    registry.listRepos.mockResolvedValueOnce([
      { owner: 'acme', repo: 'webapp', status: 'active' },
      { owner: 'acme', repo: 'archived', status: 'missing' },
    ]);
    listBranches.mockResolvedValue(gh('main', 't1'));
    const out = await reconcileBranches(env, registry);
    expect(out.repos).toBe(1); // only the active repo
  });

  test('orgApi failure skips the owner, no throw', async () => {
    orgApi.mockRejectedValueOnce(new Error('token mint failed'));
    const out = await reconcileBranches(env, registry);
    expect(out).toMatchObject({ repos: 0, resolved: 0, stopped: false });
  });

  test('a rate_limited GithubError stops the sweep', async () => {
    listBranches.mockRejectedValueOnce(new GithubError('rate_limited', 'throttled', 403));
    const out = await reconcileBranches(env, registry);
    expect(out.stopped).toBe(true);
  });

  test('a non-rate-limit error is logged and the sweep continues', async () => {
    listBranches.mockRejectedValueOnce(new Error('flaky'));
    const out = await reconcileBranches(env, registry);
    expect(out.stopped).toBe(false);
  });
});
