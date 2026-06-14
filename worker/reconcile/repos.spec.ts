import { GithubError } from '@git-lfs-hub/lib/github';
import { test, expect, vi, beforeEach, describe } from 'vitest';

const probeOrg = vi.fn();
vi.mock('@/github/probeOrg', () => ({
  probeOrg: (...args: unknown[]) => probeOrg(...args),
}));

const orgApiMock = vi.fn();
// Accounts the App is installed on — what `installedOrgs` returns. Set per test via fakeRegistry.
let installations: { login: string; id: number }[] = [];
vi.mock('@git-lfs-hub/lib/github', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@git-lfs-hub/lib/github')>();
  return {
    ...actual,
    GithubApi: class {
      static async forApp(_appId: string, _appPrivateKey: string) {
        return new this();
      }
      async installedOrgs() {
        return installations;
      }
      async orgApi(org: { login: string; id: number }) {
        return orgApiMock(org.login);
      }
    },
  };
});

import type { OrgProbeResult } from '@/github/probeOrg';
import { reconcileRepos, reconcileRepoEvent } from '@/reconcile/repos';

const unblockRepo = vi.fn(async () => {});
// Notify-only alerts: per-scope ALERTS DO stub shared across tests.
const sendNotification = vi.fn(async () => ({}));
const clearAlert = vi.fn(async () => {});
const env = {
  GITHUB_APP_ID: '1',
  GITHUB_APP_PRIVATE_KEY: 'k',
  LFS_SERVER: { unblockRepo },
  ALERTS: { getByName: () => ({ sendNotification, clearAlert }) },
} as any;

type StorageReconResult = {
  becameUnused: unknown[];
  becameUsed: unknown[];
  blockedReused: unknown[];
};

/** `installed` = accounts the App is on (the install list); `tracked` = existing `orgs` rows
 *  the uninstall sweep scans. */
function fakeRegistry(installed: string[], tracked: { org: string; status: string }[] = []) {
  installations = installed.map((login, i) => ({ login, id: i + 1 }));
  const orgStatuses: { org: string; status: string; error?: string | null }[] = [];
  let lastReconcileInput: { activeOrgs: Set<string>; activeRepos: Set<string> } | null = null;
  let gitResult = {
    missing: [] as unknown[],
    reappeared: [] as unknown[],
  };
  // All storage rows — the level-triggered notification source (`listStorage`), independent
  // of this run's flips.
  let storageRows: { prefix: string; status: string; archivedAt?: string | null }[] = [];
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
    setStorageRows(r: { prefix: string; status: string; archivedAt?: string | null }[]) {
      storageRows = r;
    },
    setStorageResult(r: StorageReconResult) {
      storageResult = r;
    },
    listStorage: vi.fn(async () => storageRows),
    getLastReconcileInput() {
      return lastReconcileInput;
    },
    listOrgs: vi.fn(async () => tracked),
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
  sendNotification.mockClear();
  clearAlert.mockClear();
  // default: orgApi returns a fake GithubOrgApi-shaped stub
  orgApiMock.mockResolvedValue({});
});

describe('reconcileRepos', () => {
  test('no installations → no-op, no probe, no record', async () => {
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

  test('installed org with no prior storage is still probed (onboarding gap closed)', async () => {
    // No storage rows anywhere — reconcile is driven purely by the install list now.
    const registry = fakeRegistry(['newbie']);
    probeOrg.mockResolvedValue({ status: 'active', activeRepos: new Set(['newbie/repo']) });
    await reconcileRepos(env, registry);
    expect(probeOrg).toHaveBeenCalledOnce();
    expect(registry.getLastReconcileInput()).toEqual({
      activeOrgs: new Set(['newbie']),
      activeRepos: new Set(['newbie/repo']),
    });
  });

  test('uninstall sweep: tracked org absent from install list → no_installation, repos untouched', async () => {
    // 'a' is installed; 'gone' is a tracked org row no longer in the install list.
    const registry = fakeRegistry(
      ['a'],
      [
        { org: 'a', status: 'active' },
        { org: 'gone', status: 'active' },
      ],
    );
    probeOrg.mockResolvedValue({ status: 'active', activeRepos: new Set(['a/x']) });
    const r = await reconcileRepos(env, registry);
    expect(registry.upsertOrgStatus).toHaveBeenCalledWith('gone', 'no_installation');
    expect(r.orgs.no_installation).toContain('gone');
    // status-only: 'gone' never enters activeOrgs, so no repo/storage cascade.
    expect(registry.getLastReconcileInput()?.activeOrgs).toEqual(new Set(['a']));
  });

  test('uninstall sweep: org already no_installation is not re-marked', async () => {
    const registry = fakeRegistry(['a'], [{ org: 'gone', status: 'no_installation' }]);
    probeOrg.mockResolvedValue({ status: 'active', activeRepos: new Set(['a/x']) });
    await reconcileRepos(env, registry);
    expect(registry.upsertOrgStatus).not.toHaveBeenCalledWith('gone', 'no_installation');
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

  test('cold-start guard: all orgs enumerated → full scan', async () => {
    const registry = fakeRegistry(['a', 'b']);
    probeOrg
      .mockResolvedValueOnce({ status: 'active', activeRepos: new Set(['a/x']) })
      .mockResolvedValueOnce({ status: 'forbidden', error: '403' }); // definitive, still trustworthy
    const r = await reconcileRepos(env, registry);
    expect(r.fullScan).toBe(true);
  });

  test('cold-start guard: a transient_error org → not a full scan', async () => {
    const registry = fakeRegistry(['a', 'b']);
    probeOrg
      .mockResolvedValueOnce({ status: 'active', activeRepos: new Set(['a/x']) })
      .mockResolvedValueOnce({ status: 'transient_error', error: '5xx' });
    const r = await reconcileRepos(env, registry);
    expect(r.fullScan).toBe(false);
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

  test('alerts are storage-state level-triggered: unused → missing, archived → archived', async () => {
    const registry = fakeRegistry(['a']);
    probeOrg.mockResolvedValue({ status: 'active', activeRepos: new Set(['a/x']) });
    registry.setStorageRows([
      { prefix: 'a/orphan', status: 'unused', archivedAt: null }, // never tracked → missing
      { prefix: 'a/gone', status: 'unused', archivedAt: null }, // repo deleted → missing
      { prefix: 'a/blocked', status: 'unused', archivedAt: 't' }, // archived → archived (not missing)
      { prefix: 'a/live', status: 'used', archivedAt: null }, // in use → no alert
      { prefix: 'a/dead', status: 'purged', archivedAt: 't' }, // purged → skipped
    ]);
    await reconcileRepos(env, registry);
    expect(sendNotification).toHaveBeenCalledWith({ kind: 'missing', scope: 'storage:a/orphan' });
    expect(sendNotification).toHaveBeenCalledWith({ kind: 'missing', scope: 'storage:a/gone' });
    expect(sendNotification).toHaveBeenCalledWith({ kind: 'archived', scope: 'storage:a/blocked' });
    expect(sendNotification).not.toHaveBeenCalledWith({ kind: 'missing', scope: 'storage:a/live' });
    expect(sendNotification).not.toHaveBeenCalledWith({ kind: 'missing', scope: 'storage:a/dead' });
  });

  test('reappearance (storage became used) → reappeared, clears missing', async () => {
    const registry = fakeRegistry(['a']);
    probeOrg.mockResolvedValue({ status: 'active', activeRepos: new Set(['a/x']) });
    registry.setStorageResult({
      becameUnused: [],
      becameUsed: [{ prefix: 'a/back', archivedAt: null, clearedAt: null }],
      blockedReused: [],
    });
    await reconcileRepos(env, registry);
    expect(clearAlert).toHaveBeenCalledWith('storage:a/back', 'missing');
    expect(sendNotification).toHaveBeenCalledWith({ kind: 'reappeared', scope: 'storage:a/back' });
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

  test('present+blocked + clearedAt set → no unblock, notify-only reappeared alert', async () => {
    const registry = fakeRegistry(['a']);
    probeOrg.mockResolvedValue({ status: 'active', activeRepos: new Set(['a/z']) });
    registry.setStorageResult({
      becameUnused: [],
      becameUsed: [],
      blockedReused: [{ prefix: 'a/z', archivedAt: 't', clearedAt: '2026-01-01T00:00:00Z' }],
    });
    const r = await reconcileRepos(env, registry);
    expect(unblockRepo).not.toHaveBeenCalled();
    expect(registry.unblock).not.toHaveBeenCalled();
    expect(r.repos.clearedReappeared).toBe(1);
    expect(sendNotification).toHaveBeenCalledWith({ kind: 'reappeared', scope: 'storage:a/z' });
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
    becameUnused?: unknown[];
    becameUsed?: unknown[];
    blockedReused?: unknown[];
  }) {
    return {
      applyRepoEvent: vi.fn(async () => opts.applyResult),
      storageForRepo: vi.fn(async () => opts.store ?? null),
      reconcileStoragePrefix: vi.fn(async () => ({
        becameUnused: opts.becameUnused ?? [],
        becameUsed: opts.becameUsed ?? [],
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

  test('storage became unused (repo gone) → missing alert for the prefix', async () => {
    const registry = eventRegistry({
      applyResult: { row: { owner: 'a', repo: 'x' }, reappeared: false },
      store: { prefix: 'a/x' },
      becameUnused: [{ prefix: 'a/x' }],
    });
    await reconcileRepoEvent(env, registry, 'a', 'x', false);
    expect(sendNotification).toHaveBeenCalledWith({ kind: 'missing', scope: 'storage:a/x' });
  });

  test('storage became used (repo back) → reappeared alert for the prefix', async () => {
    const registry = eventRegistry({
      applyResult: { row: { owner: 'a', repo: 'x' }, reappeared: true },
      store: { prefix: 'a/x' },
      becameUsed: [{ prefix: 'a/x', archivedAt: null }],
    });
    await reconcileRepoEvent(env, registry, 'a', 'x', true);
    expect(sendNotification).toHaveBeenCalledWith({ kind: 'reappeared', scope: 'storage:a/x' });
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

  test('present + blocked + clearedAt set → notify-only reappeared alert, no unblock', async () => {
    const registry = eventRegistry({
      applyResult: { row: { owner: 'a', repo: 'z' }, reappeared: true },
      store: { prefix: 'a/z' },
      blockedReused: [{ prefix: 'a/z', archivedAt: 't', clearedAt: 'c' }],
    });
    await reconcileRepoEvent(env, registry, 'a', 'z', true);
    expect(unblockRepo).not.toHaveBeenCalled();
    expect(registry.unblock).not.toHaveBeenCalled();
    expect(sendNotification).toHaveBeenCalledWith({ kind: 'reappeared', scope: 'storage:a/z' });
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
