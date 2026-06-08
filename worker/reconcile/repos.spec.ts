import { GithubError } from '@git-lfs-hub/lib/github';
import { test, expect, vi, beforeEach, describe } from 'vitest';

const probeOrg = vi.fn();
vi.mock('@/github/probeOrg', () => ({
  probeOrg: (...args: unknown[]) => probeOrg(...args),
}));

const orgApiMock = vi.fn();
vi.mock('@git-lfs-hub/lib/github', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@git-lfs-hub/lib/github')>();
  return {
    ...actual,
    GithubApi: class {
      static async forApp(_appId: string, _appPrivateKey: string) {
        return new this();
      }
      async orgApi(org: string) {
        return orgApiMock(org);
      }
    },
  };
});

import type { OrgProbeResult } from '@/github/probeOrg';
import { reconcileRepos, reconcileRepoEvent } from '@/reconcile/repos';

const unblockRepo = vi.fn(async () => {});
const env = {
  GITHUB_APP_ID: '1',
  GITHUB_APP_PRIVATE_KEY: 'k',
  LFS_SERVER: { unblockRepo },
} as any;

type StorageReconResult = {
  becameUnused: unknown[];
  becameUsed: unknown[];
  blockedReused: unknown[];
};

function fakeRegistry(owners: string[]) {
  const orgStatuses: { org: string; status: string; error?: string | null }[] = [];
  let lastReconcileInput: { activeOrgs: Set<string>; activeRepos: Set<string> } | null = null;
  let gitResult = {
    missing: [] as unknown[],
    reappeared: [] as unknown[],
  };
  let storageResult: StorageReconResult = {
    becameUnused: [],
    becameUsed: [],
    blockedReused: [],
  };
  return {
    orgStatuses,
    setGitResult(r: typeof gitResult) {
      gitResult = r;
    },
    setStorageResult(r: StorageReconResult) {
      storageResult = r;
    },
    getLastReconcileInput() {
      return lastReconcileInput;
    },
    listOwners: vi.fn(async () => owners),
    unblock: vi.fn(async (prefix: string) => ({ prefix })),
    upsertOrgStatus: vi.fn(async (org: string, status: string, error?: string | null) => {
      orgStatuses.push({ org, status, error });
      return { org, status };
    }),
    recordReconciliation: vi.fn(
      async (input: { activeOrgs: Set<string>; activeRepos: Set<string> }) => {
        lastReconcileInput = input;
        return gitResult;
      },
    ),
    reconcileStorage: vi.fn(async () => storageResult),
  } as any;
}

beforeEach(() => {
  probeOrg.mockReset();
  orgApiMock.mockReset();
  unblockRepo.mockReset();
  unblockRepo.mockResolvedValue(undefined);
  // default: orgApi returns a fake GithubOrgApi-shaped stub
  orgApiMock.mockResolvedValue({});
});

describe('reconcileRepos', () => {
  test('empty owners → no-op, no probe, no record', async () => {
    const registry = fakeRegistry([]);
    const summary = await reconcileRepos(env, registry);
    expect(probeOrg).not.toHaveBeenCalled();
    expect(registry.recordReconciliation).not.toHaveBeenCalled();
    expect(summary.repos.active).toBe(0);
    expect(summary.orgs.active).toEqual([]);
  });

  test('single active org → activeRepos passed through', async () => {
    const registry = fakeRegistry(['alice']);
    probeOrg.mockResolvedValue({
      status: 'active',
      activeRepos: new Set(['alice/foo']),
    } satisfies OrgProbeResult);
    await reconcileRepos(env, registry);
    expect(registry.upsertOrgStatus).toHaveBeenCalledWith('alice', 'active', null);
    expect(registry.getLastReconcileInput()).toEqual({
      activeOrgs: new Set(['alice']),
      activeRepos: new Set(['alice/foo']),
    });
  });

  test('non-active org not in activeOrgs; status recorded with error', async () => {
    const registry = fakeRegistry(['a', 'b']);
    probeOrg
      .mockResolvedValueOnce({ status: 'active', activeRepos: new Set(['a/x']) })
      .mockResolvedValueOnce({ status: 'forbidden', error: '403' });
    await reconcileRepos(env, registry);
    expect(registry.getLastReconcileInput()?.activeOrgs).toEqual(new Set(['a']));
    expect(registry.orgStatuses).toEqual([
      { org: 'a', status: 'active', error: null },
      { org: 'b', status: 'forbidden', error: '403' },
    ]);
  });

  test('missing org → activeRepos union excludes it', async () => {
    const registry = fakeRegistry(['a', 'b']);
    probeOrg
      .mockResolvedValueOnce({ status: 'active', activeRepos: new Set(['a/x']) })
      .mockResolvedValueOnce({ status: 'missing', error: '404' });
    await reconcileRepos(env, registry);
    const input = registry.getLastReconcileInput()!;
    expect(input.activeOrgs).toEqual(new Set(['a']));
    expect(input.activeRepos).toEqual(new Set(['a/x']));
  });

  test("transient_error → no mutation on that org's rows", async () => {
    const registry = fakeRegistry(['x']);
    probeOrg.mockResolvedValue({ status: 'transient_error', error: '5xx' });
    const r = await reconcileRepos(env, registry);
    expect(r.orgs.transient_error).toEqual(['x']);
    expect(registry.getLastReconcileInput()?.activeOrgs).toEqual(new Set());
  });

  test('summary counts reflect git + storage results', async () => {
    const registry = fakeRegistry(['a']);
    probeOrg.mockResolvedValue({ status: 'active', activeRepos: new Set(['a/x', 'a/y']) });
    registry.setGitResult({
      missing: [{}, {}],
      reappeared: [{ owner: 'a', repo: 'm', name: 'a/m' }],
    });
    registry.setStorageResult({
      becameUnused: [],
      becameUsed: [],
      blockedReused: [
        { prefix: 'a/x', archivedAt: 't', clearedAt: null },
        { prefix: 'a/y', archivedAt: 't', clearedAt: null },
        { prefix: 'a/z', archivedAt: 't', clearedAt: '2026-01-01T00:00:00Z' },
      ],
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await reconcileRepos(env, registry);
    expect(r.repos.active).toBe(2);
    expect(r.repos.missing).toBe(2);
    expect(r.repos.reappeared).toBe(1);
    expect(r.repos.unblocked).toBe(2);
    expect(r.repos.clearedReappeared).toBe(1);
    warn.mockRestore();
  });

  test('auto-unblock: present+blocked (clearedAt null) → unblockRepo + registry.unblock', async () => {
    const registry = fakeRegistry(['a']);
    probeOrg.mockResolvedValue({ status: 'active', activeRepos: new Set(['a/x']) });
    registry.setStorageResult({
      becameUnused: [],
      becameUsed: [],
      blockedReused: [{ prefix: 'a/x', archivedAt: 't', clearedAt: null }],
    });
    await reconcileRepos(env, registry);
    expect(unblockRepo).toHaveBeenCalledWith('a', 'x');
    expect(registry.unblock).toHaveBeenCalledWith('a/x');
  });

  test('present+blocked + clearedAt set → no unblock, notify-only warn', async () => {
    const registry = fakeRegistry(['a']);
    probeOrg.mockResolvedValue({ status: 'active', activeRepos: new Set(['a/z']) });
    registry.setStorageResult({
      becameUnused: [],
      becameUsed: [],
      blockedReused: [{ prefix: 'a/z', archivedAt: 't', clearedAt: '2026-01-01T00:00:00Z' }],
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await reconcileRepos(env, registry);
    expect(unblockRepo).not.toHaveBeenCalled();
    expect(registry.unblock).not.toHaveBeenCalled();
    expect(r.repos.clearedReappeared).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('reappeared'));
    warn.mockRestore();
  });

  test('auto-unblock (clearedAt null) does not emit the cleared alert', async () => {
    const registry = fakeRegistry(['a']);
    probeOrg.mockResolvedValue({ status: 'active', activeRepos: new Set(['a/x']) });
    registry.setStorageResult({
      becameUnused: [],
      becameUsed: [],
      blockedReused: [{ prefix: 'a/x', archivedAt: 't', clearedAt: null }],
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await reconcileRepos(env, registry);
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('manual restore'));
    warn.mockRestore();
  });

  test('auto-unblock: RPC failure leaves the block (no registry.unblock)', async () => {
    const registry = fakeRegistry(['a']);
    probeOrg.mockResolvedValue({ status: 'active', activeRepos: new Set(['a/x']) });
    registry.setStorageResult({
      becameUnused: [],
      becameUsed: [],
      blockedReused: [{ prefix: 'a/x', archivedAt: 't', clearedAt: null }],
    });
    unblockRepo.mockRejectedValueOnce(new Error('rpc down'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await reconcileRepos(env, registry);
    expect(registry.unblock).not.toHaveBeenCalled();
    expect(r.repos.unblocked).toBe(0);
    err.mockRestore();
  });

  test('listing errors classified by code, no throw out of reconcileRepos', async () => {
    const registry = fakeRegistry(['b', 'c', 'd']);
    probeOrg
      .mockRejectedValueOnce(new GithubError('forbidden', '403'))
      .mockRejectedValueOnce(new GithubError('missing', '404'))
      .mockRejectedValueOnce(new GithubError('transient', '5xx'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await reconcileRepos(env, registry);
    expect(r.orgs.forbidden).toEqual(['b']);
    expect(r.orgs.missing).toEqual(['c']);
    expect(r.orgs.transient_error).toEqual(['d']);
    expect(registry.getLastReconcileInput()?.activeOrgs).toEqual(new Set());
    warn.mockRestore();
  });

  test('acquisition no_installation classified, probeOrg not called for that org', async () => {
    const registry = fakeRegistry(['ghost', 'alice']);
    orgApiMock
      .mockRejectedValueOnce(new GithubError('no_installation', 'no install for ghost'))
      .mockResolvedValueOnce({});
    probeOrg.mockResolvedValueOnce({ status: 'active', activeRepos: new Set(['alice/x']) });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await reconcileRepos(env, registry);
    expect(r.orgs.no_installation).toEqual(['ghost']);
    expect(r.orgs.active).toEqual(['alice']);
    expect(probeOrg).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  test('unauthorized → transient_error', async () => {
    const registry = fakeRegistry(['a']);
    orgApiMock.mockRejectedValueOnce(new GithubError('unauthorized', '401'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await reconcileRepos(env, registry);
    expect(r.orgs.transient_error).toEqual(['a']);
    warn.mockRestore();
  });

  test('non-GithubError throw → transient_error with raw message', async () => {
    const registry = fakeRegistry(['a']);
    orgApiMock.mockRejectedValueOnce(new Error('boom'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await reconcileRepos(env, registry);
    expect(registry.orgStatuses).toEqual([{ org: 'a', status: 'transient_error', error: 'boom' }]);
    warn.mockRestore();
  });
});

describe('reconcileRepoEvent', () => {
  function eventRegistry(opts: {
    applyResult: unknown;
    store?: unknown;
    blockedReused?: unknown[];
  }) {
    return {
      applyRepoEvent: vi.fn(async () => opts.applyResult),
      storageForRepo: vi.fn(async () => opts.store ?? null),
      reconcileStoragePrefix: vi.fn(async () => ({
        becameUnused: [],
        becameUsed: [],
        blockedReused: opts.blockedReused ?? [],
      })),
      unblock: vi.fn(async (prefix: string) => ({ prefix })),
    } as any;
  }

  test('presence flip with no storage row → no unblock', async () => {
    const registry = eventRegistry({
      applyResult: { row: { owner: 'a', repo: 'x' }, reappeared: false },
      store: null,
    });
    await reconcileRepoEvent(env, registry, 'a', 'x', false);
    expect(registry.applyRepoEvent).toHaveBeenCalledWith('a', 'x', false);
    expect(registry.storageForRepo).toHaveBeenCalledWith('a', 'x');
    expect(unblockRepo).not.toHaveBeenCalled();
  });

  test('untracked repo (null) → no storage lookup, no unblock', async () => {
    const registry = eventRegistry({ applyResult: null });
    await reconcileRepoEvent(env, registry, 'a', 'x', true);
    expect(registry.storageForRepo).not.toHaveBeenCalled();
    expect(unblockRepo).not.toHaveBeenCalled();
    expect(registry.unblock).not.toHaveBeenCalled();
  });

  test('present + blocked + clearedAt null → unblockRepo + registry.unblock', async () => {
    const registry = eventRegistry({
      applyResult: { row: { owner: 'a', repo: 'x' }, reappeared: true },
      store: { prefix: 'a/x' },
      blockedReused: [{ prefix: 'a/x', archivedAt: 't', clearedAt: null }],
    });
    await reconcileRepoEvent(env, registry, 'a', 'x', true);
    expect(registry.reconcileStoragePrefix).toHaveBeenCalledWith('a/x');
    expect(unblockRepo).toHaveBeenCalledWith('a', 'x');
    expect(registry.unblock).toHaveBeenCalledWith('a/x');
  });

  test('present + blocked + clearedAt set → notify-only warn, no unblock', async () => {
    const registry = eventRegistry({
      applyResult: { row: { owner: 'a', repo: 'z' }, reappeared: true },
      store: { prefix: 'a/z' },
      blockedReused: [{ prefix: 'a/z', archivedAt: 't', clearedAt: 'c' }],
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await reconcileRepoEvent(env, registry, 'a', 'z', true);
    expect(unblockRepo).not.toHaveBeenCalled();
    expect(registry.unblock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('manual restore'));
    warn.mockRestore();
  });

  test('unblock RPC failure leaves the block (no registry.unblock)', async () => {
    const registry = eventRegistry({
      applyResult: { row: { owner: 'a', repo: 'x' }, reappeared: true },
      store: { prefix: 'a/x' },
      blockedReused: [{ prefix: 'a/x', archivedAt: 't', clearedAt: null }],
    });
    unblockRepo.mockRejectedValueOnce(new Error('rpc down'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await reconcileRepoEvent(env, registry, 'a', 'x', true);
    expect(registry.unblock).not.toHaveBeenCalled();
    err.mockRestore();
  });
});
