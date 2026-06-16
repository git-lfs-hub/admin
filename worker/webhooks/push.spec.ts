import { test, expect, vi, beforeEach, describe } from 'vitest';

const scanLfsconfig = vi.fn(async (..._a: unknown[]) => 'ok');
vi.mock('@/github/lfsconfig', () => ({
  scanLfsconfig: (...a: unknown[]) => scanLfsconfig(...a),
}));

const orgApi = vi.fn(async () => ({}));
const forApp = vi.fn(async () => ({ orgApi }));
vi.mock('@git-lfs-hub/lib/github', () => ({ GithubApi: { forApp: (...a: unknown[]) => forApp(...a) } }));

vi.mock('@/reconcile/repos', () => ({
  allowedOrgs: (e: { GITHUB_ORGS?: string }) =>
    new Set((e.GITHUB_ORGS ?? '').split(/\s+/).filter(Boolean)),
}));

const getBranch = vi.fn(async (): Promise<unknown> => null);
const recordHead = vi.fn(async () => {});
const syncLinks = vi.fn(async () => {});
const repoStub = { getBranch, recordHead, syncLinks };
vi.mock('@/db/repo', () => ({ Repo: { byRepo: () => repoStub } }));

import { handlePush } from '@/webhooks/push';

const env = { GITHUB_ORGS: 'acme', GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: 'k' } as any;

const push = (over: Record<string, unknown> = {}) => ({
  ref: 'refs/heads/main',
  after: 'c1',
  repository: { name: 'repo', default_branch: 'main', owner: { login: 'acme' } },
  installation: { id: 5 },
  commits: [{ added: [], modified: [], removed: [] }],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  getBranch.mockResolvedValue(null);
});

describe('handlePush', () => {
  test('.lfsconfig untouched, already scanned → recordHead, no scan, syncs', async () => {
    getBranch.mockResolvedValue({ branch: 'main', headSha: 'c0' });
    await handlePush(env, push());
    expect(scanLfsconfig).not.toHaveBeenCalled();
    expect(recordHead).toHaveBeenCalledWith('main', 'c1');
    expect(syncLinks).toHaveBeenCalledWith('acme', 'repo');
  });

  test.each(['added', 'modified', 'removed'])('.lfsconfig in %s → scan, no recordHead', async (k) => {
    getBranch.mockResolvedValue({ branch: 'main', headSha: 'c0' });
    await handlePush(env, push({ commits: [{ [k]: ['.lfsconfig'] }] }));
    expect(scanLfsconfig).toHaveBeenCalledTimes(1);
    expect(recordHead).not.toHaveBeenCalled();
    expect(syncLinks).toHaveBeenCalledWith('acme', 'repo');
  });

  test('repo never scanned → scan even when diff lacks .lfsconfig', async () => {
    await handlePush(env, push());
    expect(scanLfsconfig).toHaveBeenCalledTimes(1);
    expect(recordHead).not.toHaveBeenCalled();
  });

  test('non-default branch → ignored', async () => {
    await handlePush(env, push({ ref: 'refs/heads/dev' }));
    expect(scanLfsconfig).not.toHaveBeenCalled();
    expect(recordHead).not.toHaveBeenCalled();
    expect(syncLinks).not.toHaveBeenCalled();
  });

  test('owner outside GITHUB_ORGS → no-op', async () => {
    await handlePush(env, push({ repository: { name: 'r', default_branch: 'main', owner: { login: 'stranger' } } }));
    expect(scanLfsconfig).not.toHaveBeenCalled();
    expect(syncLinks).not.toHaveBeenCalled();
  });

  test('owner from repository.owner.name (no login) still resolves', async () => {
    getBranch.mockResolvedValue({ branch: 'main', headSha: 'c0' });
    await handlePush(env, push({ repository: { name: 'repo', default_branch: 'main', owner: { name: 'acme' } } }));
    expect(syncLinks).toHaveBeenCalledWith('acme', 'repo');
  });

  test('no commits array, already scanned → recordHead', async () => {
    getBranch.mockResolvedValue({ branch: 'main', headSha: 'c0' });
    await handlePush(env, push({ commits: undefined }));
    expect(scanLfsconfig).not.toHaveBeenCalled();
    expect(recordHead).toHaveBeenCalledWith('main', 'c1');
  });

  test('scan needed but no installation id → bail before syncLinks', async () => {
    await handlePush(env, push({ installation: undefined }));
    expect(scanLfsconfig).not.toHaveBeenCalled();
    expect(syncLinks).not.toHaveBeenCalled();
  });
});
