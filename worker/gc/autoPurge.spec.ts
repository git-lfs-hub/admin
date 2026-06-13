import { beforeEach, describe, expect, test, vi } from 'vitest';

import { autoPurge } from '@/gc/autoPurge';
import { isoAddDays, isoNow } from '@/lib/time';

// Only `startWorkflow` is stubbed; the real `terminateWorkflow` drives the reappearance-termination
// tests against the mocked Storage below.
const startWorkflow = vi.fn(async (..._a: unknown[]) => 'purge-id');
vi.mock('@/workflows/lifecycle', async (orig) => ({
  ...(await orig<typeof import('@/workflows/lifecycle')>()),
  startWorkflow: (...a: unknown[]) => startWorkflow(...a),
}));

const endOp = vi.fn(async () => {});
const activeInstanceId = vi.fn(async () => 'purge-a/r');
vi.mock('@/db/storage', () => ({
  Storage: { byPrefix: () => ({ endOp, activeInstanceId }) },
}));

const clearAlert = vi.fn(async () => {});
vi.mock('@/db/alerts', () => ({ Alerts: { global: () => ({ clearAlert }) } }));

const terminate = vi.fn(() => {});
const env = {
  GC: { retentionDays: { live: 30 } },
  PURGE_WORKFLOW: { get: vi.fn(async () => ({ terminate })) },
} as any;

function fakeRegistry(rows: unknown[], opts: { inUse?: Set<string> } = {}) {
  const inUse = opts.inUse ?? new Set<string>();
  return {
    listStorage: vi.fn(async () => rows),
    storageInUse: vi.fn(async (prefix: string) => inUse.has(prefix)),
  } as any;
}

const daysAgo = (n: number) => isoAddDays(isoNow(), -n);
const row = (over: Record<string, unknown>) => ({
  prefix: 'a/r',
  status: 'unused',
  archivedAt: null,
  activeOp: null,
  ...over,
});

beforeEach(() => vi.clearAllMocks());

describe('autoPurge', () => {
  test('retention elapsed → starts a wait-only (auto) purge', async () => {
    const registry = fakeRegistry([row({ archivedAt: daysAgo(31) })]); // 31 > retention 30
    const out = await autoPurge(env, registry);
    expect(startWorkflow).toHaveBeenCalledWith(env, 'purge', {
      prefix: 'a/r',
      scope: 'storage:a/r',
      triggeredBy: 'auto',
    });
    expect(out).toHaveLength(1);
  });

  test('cold storage → uses cold retention (live retention ignored)', async () => {
    const coldEnv = {
      ...env,
      GC: { retentionDays: { live: 30, cold: 365 }, coldStorage: 's3.backup' },
    };
    // Past live retention but within cold retention → not yet purged.
    expect(await autoPurge(coldEnv, fakeRegistry([row({ archivedAt: daysAgo(31) })]))).toEqual([]);
    expect(startWorkflow).not.toHaveBeenCalled();
    // Past cold retention → cold purge starts (workflow drops both live + cold copy).
    const out = await autoPurge(coldEnv, fakeRegistry([row({ archivedAt: daysAgo(366) })]));
    expect(startWorkflow).toHaveBeenCalledWith(coldEnv, 'purge', {
      prefix: 'a/r',
      scope: 'storage:a/r',
      triggeredBy: 'auto',
    });
    expect(out).toHaveLength(1);
  });

  test('within retention → skipped', async () => {
    const registry = fakeRegistry([row({ archivedAt: daysAgo(1) })]);
    await autoPurge(env, registry);
    expect(startWorkflow).not.toHaveBeenCalled();
  });

  test('not blocked (archivedAt null) → skipped', async () => {
    const registry = fakeRegistry([row({ archivedAt: null })]);
    await autoPurge(env, registry);
    expect(startWorkflow).not.toHaveBeenCalled();
  });

  test('purged → skipped', async () => {
    const registry = fakeRegistry([row({ status: 'purged', archivedAt: daysAgo(31) })]);
    await autoPurge(env, registry);
    expect(startWorkflow).not.toHaveBeenCalled();
  });

  test('git repo active again (in use) → not purged', async () => {
    const registry = fakeRegistry([row({ archivedAt: daysAgo(31) })], { inUse: new Set(['a/r']) });
    await autoPurge(env, registry);
    expect(startWorkflow).not.toHaveBeenCalled();
  });

  test('an op already running → skipped', async () => {
    const registry = fakeRegistry([row({ archivedAt: daysAgo(31), activeOp: 'backup' })]);
    await autoPurge(env, registry);
    expect(startWorkflow).not.toHaveBeenCalled();
  });

  test('reappearance (unblocked) with in-flight purge → terminated, op ended, alert cleared', async () => {
    const registry = fakeRegistry([row({ archivedAt: null, status: 'used', activeOp: 'purge' })]);
    await autoPurge(env, registry);
    expect(terminate).toHaveBeenCalled();
    expect(endOp).toHaveBeenCalledWith('a/r', 'purge-a/r', 'terminated', 'used');
    expect(clearAlert).toHaveBeenCalledWith('storage:a/r', 'purge');
    expect(startWorkflow).not.toHaveBeenCalled();
  });

  test('reappearance (repo active) with in-flight purge → terminated', async () => {
    const registry = fakeRegistry([row({ archivedAt: daysAgo(31), activeOp: 'purge' })], {
      inUse: new Set(['a/r']),
    });
    await autoPurge(env, registry);
    expect(terminate).toHaveBeenCalled();
    expect(endOp).toHaveBeenCalledWith('a/r', 'purge-a/r', 'terminated', 'unused');
  });

  test('caps instances per tick', async () => {
    const rows = Array.from({ length: 15 }, (_, i) =>
      row({ prefix: `a/r${i}`, archivedAt: daysAgo(31) }),
    );
    const out = await autoPurge(env, fakeRegistry(rows));
    expect(out).toHaveLength(10);
    expect(startWorkflow).toHaveBeenCalledTimes(10);
  });

  test('startWorkflow failure → logged, others continue', async () => {
    startWorkflow.mockRejectedValueOnce(new Error('busy'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const registry = fakeRegistry([
      row({ prefix: 'a/x', archivedAt: daysAgo(31) }),
      row({ prefix: 'a/y', archivedAt: daysAgo(31) }),
    ]);
    const out = await autoPurge(env, registry);
    expect(startWorkflow).toHaveBeenCalledTimes(2);
    expect(out).toHaveLength(1); // only the second succeeded
    err.mockRestore();
  });
});
