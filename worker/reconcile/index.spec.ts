import { test, expect, vi, beforeEach, describe } from 'vitest';

const discoverRepos = vi.fn(async (..._a: unknown[]) => {});
const reconcileRepos = vi.fn(async (..._a: unknown[]) => {});
const reconcileObjects = vi.fn(async (..._a: unknown[]) => {});
const autoArchive = vi.fn(async (..._a: unknown[]) => []);

vi.mock('@/storage/discovery', () => ({ discoverRepos: (...a: unknown[]) => discoverRepos(...a) }));
vi.mock('@/reconcile/repos', () => ({ reconcileRepos: (...a: unknown[]) => reconcileRepos(...a) }));
vi.mock('@/reconcile/objects', () => ({
  reconcileObjects: (...a: unknown[]) => reconcileObjects(...a),
}));
vi.mock('@/gc/autoArchive', () => ({ autoArchive: (...a: unknown[]) => autoArchive(...a) }));

import { reconcileAll } from '@/reconcile/index';

const registryStub = { id: 'registry', listStorage: vi.fn(async (): Promise<unknown[]> => []) };
const storeStub = { id: 'store' };

function makeEnv() {
  return {
    REGISTRY: { getByName: vi.fn(() => registryStub) },
    STORAGE: { getByName: vi.fn(() => storeStub) },
    LFS_BUCKET: { bucket: true },
  } as any;
}

beforeEach(() => {
  discoverRepos.mockClear();
  reconcileRepos.mockClear();
  reconcileObjects.mockClear();
  autoArchive.mockClear();
  registryStub.listStorage.mockClear();
});

describe('reconcileAll', () => {
  test('discovers then reconciles against the global Registry DO', async () => {
    const env = makeEnv();
    await reconcileAll(env);
    expect(env.REGISTRY.getByName).toHaveBeenCalledWith('global');
    expect(discoverRepos).toHaveBeenCalledWith(env.LFS_BUCKET, registryStub);
    expect(reconcileRepos).toHaveBeenCalledWith(env, registryStub);
    expect(autoArchive).toHaveBeenCalledWith(env, registryStub);
  });

  test('local flag skips reconcileRepos but still reconciles objects', async () => {
    const env = makeEnv();
    registryStub.listStorage.mockResolvedValueOnce([{ prefix: 'alice/a', status: 'used' }]);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await reconcileAll(env, true);
    expect(reconcileRepos).not.toHaveBeenCalled();
    expect(reconcileObjects).toHaveBeenCalledWith(env.LFS_BUCKET, storeStub, 'alice/a/');
  });

  test('ENV=local skips reconcileRepos', async () => {
    const env = makeEnv();
    env.ENV = 'local';
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await reconcileAll(env);
    expect(reconcileRepos).not.toHaveBeenCalled();
  });

  test('reconciles objects per non-purged prefix by name', async () => {
    const env = makeEnv();
    registryStub.listStorage.mockResolvedValueOnce([
      { prefix: 'alice/a', status: 'used' },
      { prefix: 'bob/b', status: 'purged' },
    ]);
    await reconcileAll(env);
    expect(env.STORAGE.getByName).toHaveBeenCalledWith('alice/a');
    expect(env.STORAGE.getByName).not.toHaveBeenCalledWith('bob/b');
    expect(reconcileObjects).toHaveBeenCalledTimes(1);
    expect(reconcileObjects).toHaveBeenCalledWith(env.LFS_BUCKET, storeStub, 'alice/a/');
  });

  test('object pass still runs when GitHub repo reconciliation throws', async () => {
    const env = makeEnv();
    reconcileRepos.mockRejectedValueOnce(new Error('no github creds'));
    registryStub.listStorage.mockResolvedValueOnce([{ prefix: 'alice/a', status: 'used' }]);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(reconcileAll(env)).resolves.toBeUndefined();
    expect(reconcileObjects).toHaveBeenCalledWith(env.LFS_BUCKET, storeStub, 'alice/a/');
  });

  test("one prefix's object failure does not abort the rest", async () => {
    const env = makeEnv();
    registryStub.listStorage.mockResolvedValueOnce([
      { prefix: 'alice/a', status: 'used' },
      { prefix: 'bob/b', status: 'used' },
    ]);
    reconcileObjects.mockRejectedValueOnce(new Error('boom')); // alice/a fails
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await reconcileAll(env);
    expect(reconcileObjects).toHaveBeenCalledTimes(2);
    expect(reconcileObjects).toHaveBeenCalledWith(env.LFS_BUCKET, storeStub, 'bob/b/');
  });
});
