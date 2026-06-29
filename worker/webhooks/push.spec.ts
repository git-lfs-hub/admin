import { test, expect, vi, beforeEach, describe } from 'vitest';

const scanLfsConfig = vi.fn(async (..._a: unknown[]) => 'ok');
vi.mock('@/github/lfsconfig', () => ({
  scanLfsConfig: (...a: unknown[]) => scanLfsConfig(...a),
}));

const applyPushEvent = vi.fn(async (..._a: unknown[]) => 'delta');
vi.mock('@/github/branches', () => ({
  applyPushEvent: (...a: unknown[]) => applyPushEvent(...a),
}));

const orgApi = vi.fn(async () => ({}));
const forApp = vi.fn(async (..._a: unknown[]) => ({ orgApi }));
vi.mock('@git-lfs-hub/lib/github', () => ({
  GithubApi: { forApp: (...a: unknown[]) => forApp(...a) },
}));

vi.mock('@/reconcile/repos', () => ({
  allowedOrgs: (e: { GITHUB_ORGS?: string }) =>
    new Set((e.GITHUB_ORGS ?? '').split(/\s+/).filter(Boolean)),
}));

const getBranch = vi.fn(async (): Promise<unknown> => null);
const markBranchMissing = vi.fn(async () => {});
const syncLinks = vi.fn(async () => {});
const repoStub = { getBranch, markBranchMissing, syncLinks };
vi.mock('@/db/repo', () => ({ Repo: { byRepo: () => repoStub } }));

import { handlePushEvent } from '@/webhooks/push';

const env = { GITHUB_ORGS: 'acme', GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: 'k' } as any;

const push = (over: Record<string, unknown> = {}) => ({
  ref: 'refs/heads/main',
  before: 'c0',
  after: 'c1',
  head_commit: { tree_id: 't1' },
  repository: { name: 'repo', default_branch: 'main', owner: { login: 'acme' } },
  installation: { id: 5 },
  commits: [{ added: [], modified: [], removed: [] }],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  getBranch.mockResolvedValue({ branch: 'main', headSha: 'c0', lfsconfigStatus: 'ok' });
});

describe('handlePushEvent', () => {
  test('runs the branch state machine and syncs, no lfsconfig scan when untouched + scanned', async () => {
    await handlePushEvent(env, push());
    expect(applyPushEvent).toHaveBeenCalledTimes(1);
    expect(scanLfsConfig).not.toHaveBeenCalled();
    expect(syncLinks).toHaveBeenCalledWith('acme', 'repo');
  });

  test('passes the aggregated file delta + tip to applyPushEvent', async () => {
    await handlePushEvent(
      env,
      push({
        forced: true,
        commits: [
          { added: ['a.bin'], removed: ['old.bin'] },
          { modified: ['a.bin'], added: ['old.bin'] },
        ],
      }),
    );
    const branchPush = applyPushEvent.mock.calls[0][2] as any;
    expect(branchPush).toMatchObject({
      repo: 'repo',
      branch: 'main',
      before: 'c0',
      after: 'c1',
      treeSha: 't1',
      forced: true,
    });
    expect(branchPush.addedModified.sort()).toEqual(['a.bin', 'old.bin']);
    expect(branchPush.removed).toEqual([]);
  });

  test.each(['added', 'modified', 'removed'])('.lfsconfig in %s → forced scan', async (k) => {
    await handlePushEvent(env, push({ commits: [{ [k]: ['.lfsconfig'] }] }));
    expect(scanLfsConfig).toHaveBeenCalledTimes(1);
    expect(scanLfsConfig.mock.calls[0][4]).toBe(true); // force
  });

  test('branch never scanned → scan even when diff lacks .lfsconfig', async () => {
    getBranch.mockResolvedValue(null);
    await handlePushEvent(env, push());
    expect(scanLfsConfig).toHaveBeenCalledTimes(1);
  });

  test('non-default branch is tracked too (refs/heads/*)', async () => {
    await handlePushEvent(env, push({ ref: 'refs/heads/feature' }));
    expect(applyPushEvent).toHaveBeenCalledTimes(1);
    expect((applyPushEvent.mock.calls[0][2] as any).branch).toBe('feature');
    expect(syncLinks).toHaveBeenCalled();
  });

  test('branch deletion → markBranchMissing, no state machine', async () => {
    await handlePushEvent(env, push({ deleted: true }));
    expect(markBranchMissing).toHaveBeenCalledWith('main');
    expect(applyPushEvent).not.toHaveBeenCalled();
    expect(syncLinks).toHaveBeenCalledWith('acme', 'repo');
  });

  test('a tag ref (refs/tags/*) is ignored', async () => {
    await handlePushEvent(env, push({ ref: 'refs/tags/v1' }));
    expect(applyPushEvent).not.toHaveBeenCalled();
    expect(syncLinks).not.toHaveBeenCalled();
  });

  test('owner outside GITHUB_ORGS → no-op', async () => {
    await handlePushEvent(
      env,
      push({ repository: { name: 'r', default_branch: 'main', owner: { login: 'stranger' } } }),
    );
    expect(applyPushEvent).not.toHaveBeenCalled();
    expect(syncLinks).not.toHaveBeenCalled();
  });

  test('owner from repository.owner.name (no login) still resolves', async () => {
    await handlePushEvent(
      env,
      push({ repository: { name: 'repo', default_branch: 'main', owner: { name: 'acme' } } }),
    );
    expect(syncLinks).toHaveBeenCalledWith('acme', 'repo');
  });

  test('sequential push without an installation still tracks (0-call path)', async () => {
    await handlePushEvent(env, push({ installation: undefined }));
    expect(applyPushEvent).toHaveBeenCalledTimes(1);
    expect(syncLinks).toHaveBeenCalled();
  });

  test('applyPushEvent throwing is swallowed; still syncs links', async () => {
    applyPushEvent.mockRejectedValueOnce(new Error('boom'));
    await handlePushEvent(env, push());
    expect(syncLinks).toHaveBeenCalledWith('acme', 'repo');
  });

  test('lfsconfig scan throwing is swallowed; still syncs links', async () => {
    getBranch.mockResolvedValue(null); // forces a scan
    scanLfsConfig.mockRejectedValueOnce(new Error('scan boom'));
    await handlePushEvent(env, push());
    expect(syncLinks).toHaveBeenCalledWith('acme', 'repo');
  });
});
