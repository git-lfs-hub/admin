import { devScans, reconcileLocal } from '@dev/reconcileLocal';
import { describe, test, expect, vi, beforeEach } from 'vitest';

describe('devScans', () => {
  const env = { LFS: { server: 'lfs.test' } } as any;

  test('maps a linked repo to a local `.lfsconfig` scan on `main`', () => {
    const [scan] = devScans(env, ['acme/webapp'], { 'acme/webapp': 'acme/shared' });
    expect(scan).toEqual({
      owner: 'acme',
      name: 'webapp',
      branch: 'main',
      headSha: 'dev-head-acme/webapp',
      lfsconfig: {
        oid: 'dev-oid-acme/shared',
        text: '[lfs]\n\turl = https://lfs.test/lfs/acme/shared\n',
      },
    });
  });

  test('lowercases the repo key for owner/name + lookup', () => {
    const [scan] = devScans(env, ['ACME/WebApp'], { 'acme/webapp': 'acme/shared' });
    expect(scan.owner).toBe('acme');
    expect(scan.name).toBe('webapp');
    expect(scan.lfsconfig?.oid).toBe('dev-oid-acme/shared');
  });

  test('two repos sharing a prefix get the same blob oid (one cached `.lfsconfig`)', () => {
    const scans = devScans(env, ['acme/webapp', 'acme/mobile'], {
      'acme/webapp': 'acme/shared',
      'acme/mobile': 'acme/shared',
    });
    expect(scans[0].lfsconfig?.oid).toBe(scans[1].lfsconfig?.oid);
  });

  test('a present repo with no link has no `.lfsconfig` (→ unused prefix)', () => {
    const [scan] = devScans(env, ['acme/orphan'], {});
    expect(scan.lfsconfig).toBeNull();
  });
});

const recordReconciliation = vi.fn(async (_input: any) => ({ missing: [], reappeared: [] }));
const reconcileStorage = vi.fn(async () => ({
  becameUnused: [],
  becameUsed: [],
  blockedReused: [],
}));
const listStorage = vi.fn(async () => [] as { prefix: string }[]);

function fakeRegistry() {
  return { recordReconciliation, reconcileStorage, listStorage, upsertStorage: vi.fn() } as any;
}

// Each REPO stub stands in for one git repo's Durable Object; the fixture is fed through the same
// `scanLfsconfigInline` → `record*` → `syncLinks` path prod uses, so we assert on the DO writes.
const repoStubs = new Map<string, ReturnType<typeof fakeRepoStub>>();

function fakeRepoStub() {
  return {
    getBranch: vi.fn(async () => null),
    recordLfsconfig: vi.fn(async () => {}),
    recordMissing: vi.fn(async () => {}),
    syncLinks: vi.fn(async () => {}),
  };
}

function fakeEnv() {
  return {
    LFS: { server: 'lfs.test' },
    REPO: {
      getByName: vi.fn((name: string) => {
        const stub = fakeRepoStub();
        repoStubs.set(name, stub);
        return stub;
      }),
    },
  } as any;
}

beforeEach(() => {
  recordReconciliation.mockClear();
  reconcileStorage.mockClear();
  listStorage.mockClear();
  repoStubs.clear();
});

describe('reconcileLocal', () => {
  test('present list → activeRepos; owners → activeOrgs (lowercased), full scan', async () => {
    const fullScan = await reconcileLocal(
      fakeEnv(),
      fakeRegistry(),
      ['ACME/Keep', 'globex/site'],
      {},
    );
    expect(recordReconciliation).toHaveBeenCalledWith({
      activeOrgs: new Set(['acme', 'globex']),
      activeRepos: new Set(['acme/keep', 'globex/site']),
    });
    expect(reconcileStorage).toHaveBeenCalledOnce();
    expect(fullScan).toBe(true);
  });

  test('routes the fixture through the REPO DO: linked repo records its `.lfsconfig` + syncs links', async () => {
    await reconcileLocal(fakeEnv(), fakeRegistry(), ['acme/webapp'], {
      'acme/webapp': 'acme/shared',
    });
    const repo = repoStubs.get('acme/webapp')!;
    expect(repo.recordLfsconfig).toHaveBeenCalledWith(
      'main',
      'dev-head-acme/webapp',
      expect.objectContaining({ prefix: 'acme/shared', local: true, status: 'ok' }),
    );
    expect(repo.syncLinks).toHaveBeenCalledWith('acme', 'webapp');
    expect(repo.recordMissing).not.toHaveBeenCalled();
  });

  test('a present repo with no link records it missing (no link → unused prefix)', async () => {
    await reconcileLocal(fakeEnv(), fakeRegistry(), ['acme/orphan'], {});
    const repo = repoStubs.get('acme/orphan')!;
    expect(repo.recordMissing).toHaveBeenCalledWith('main', 'dev-head-acme/orphan');
    expect(repo.recordLfsconfig).not.toHaveBeenCalled();
    // `missing` still syncs links — projects the empty prefix set, dropping any prior link.
    expect(repo.syncLinks).toHaveBeenCalledWith('acme', 'orphan');
  });

  test('empty present list → no scans, every discovered repo evaluated as gone', async () => {
    await reconcileLocal(fakeEnv(), fakeRegistry(), []);
    expect(recordReconciliation).toHaveBeenCalledWith({
      activeOrgs: new Set(),
      activeRepos: new Set(),
    });
    expect(repoStubs.size).toBe(0);
  });
});
