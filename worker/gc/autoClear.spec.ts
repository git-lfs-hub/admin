import { beforeEach, describe, expect, test, vi } from 'vitest';

import { autoClear } from '@/gc/autoClear';
import { isoAddDays, isoNow } from '@/lib/time';

// Only `startWorkflow` is stubbed; the real `terminateWorkflow` drives the reappearance-termination
// tests against the mocked Storage below.
const startWorkflow = vi.fn(async (..._a: unknown[]) => 'clear-id');
vi.mock('@/workflows/lifecycle', async (orig) => ({
  ...(await orig<typeof import('@/workflows/lifecycle')>()),
  startWorkflow: (...a: unknown[]) => startWorkflow(...a),
}));

const endOp = vi.fn(async () => {});
const activeInstanceId = vi.fn(async () => 'clear-a/r');
vi.mock('@/db/storage', () => ({
  Storage: { byPrefix: () => ({ endOp, activeInstanceId }) },
}));

const clearAlert = vi.fn(async () => {});
vi.mock('@/db/alerts', () => ({ Alerts: { global: () => ({ clearAlert }) } }));

const terminate = vi.fn(() => {});
const env = {
  GC: { autoDays: { clear: 30 }, coldStorage: 's3.backup' },
  CLEAR_WORKFLOW: { get: vi.fn(async () => ({ terminate })) },
} as any;

function fakeRegistry(rows: unknown[], opts: { inUse?: Set<string> } = {}) {
  const inUse = opts.inUse ?? new Set<string>();
  return {
    listStorage: vi.fn(async () => rows),
    storageInUse: vi.fn(async (prefix: string) => inUse.has(prefix)),
  } as any;
}

const daysAgo = (n: number) => isoAddDays(isoNow(), -n);
// Eligible by default: blocked, complete cold copy, not cleared, no active op.
const row = (over: Record<string, unknown>) => ({
  prefix: 'a/r',
  status: 'used',
  archivedAt: daysAgo(31), // past the 30-day clear window
  clearedAt: null,
  backupComplete: true,
  activeOp: null,
  ...over,
});

beforeEach(() => vi.clearAllMocks());

describe('autoClear', () => {
  test('clear window elapsed → starts a wait-only (auto) clear', async () => {
    const out = await autoClear(env, fakeRegistry([row({})]));
    expect(startWorkflow).toHaveBeenCalledWith(env, 'clear', {
      prefix: 'a/r',
      scope: 'storage:a/r',
      triggeredBy: 'auto',
    });
    expect(out).toHaveLength(1);
  });

  test('cold storage off → no-op', async () => {
    const off = { ...env, GC: { autoDays: { clear: 30 } } };
    expect(await autoClear(off, fakeRegistry([row({})]))).toEqual([]);
    expect(startWorkflow).not.toHaveBeenCalled();
  });

  test('within clear window → skipped', async () => {
    await autoClear(env, fakeRegistry([row({ archivedAt: daysAgo(1) })]));
    expect(startWorkflow).not.toHaveBeenCalled();
  });

  test('no complete cold copy → skipped', async () => {
    await autoClear(env, fakeRegistry([row({ backupComplete: false })]));
    expect(startWorkflow).not.toHaveBeenCalled();
  });

  test('already cleared → skipped', async () => {
    await autoClear(env, fakeRegistry([row({ clearedAt: daysAgo(1) })]));
    expect(startWorkflow).not.toHaveBeenCalled();
  });

  test('not blocked (archivedAt null) → skipped', async () => {
    await autoClear(env, fakeRegistry([row({ archivedAt: null })]));
    expect(startWorkflow).not.toHaveBeenCalled();
  });

  test('purged → skipped', async () => {
    await autoClear(env, fakeRegistry([row({ status: 'purged' })]));
    expect(startWorkflow).not.toHaveBeenCalled();
  });

  test('an op already running → skipped', async () => {
    await autoClear(env, fakeRegistry([row({ activeOp: 'backup' })]));
    expect(startWorkflow).not.toHaveBeenCalled();
  });

  test('reappearance (unblocked) with in-flight clear → terminated, op ended, alert cleared', async () => {
    const registry = fakeRegistry([row({ archivedAt: null, activeOp: 'clear' })]);
    await autoClear(env, registry);
    expect(terminate).toHaveBeenCalled();
    expect(endOp).toHaveBeenCalledWith('a/r', 'clear-a/r', 'terminated', 'used');
    expect(clearAlert).toHaveBeenCalledWith('storage:a/r', 'clear');
    expect(startWorkflow).not.toHaveBeenCalled();
  });

  test('reappearance (repo active / in use) with in-flight clear → terminated', async () => {
    const registry = fakeRegistry([row({ activeOp: 'clear' })], { inUse: new Set(['a/r']) });
    await autoClear(env, registry);
    expect(terminate).toHaveBeenCalled();
    expect(endOp).toHaveBeenCalledWith('a/r', 'clear-a/r', 'terminated', 'used');
  });

  test('caps instances per tick', async () => {
    const rows = Array.from({ length: 15 }, (_, i) => row({ prefix: `a/r${i}` }));
    const out = await autoClear(env, fakeRegistry(rows));
    expect(out).toHaveLength(10);
    expect(startWorkflow).toHaveBeenCalledTimes(10);
  });

  test('startWorkflow failure → logged, others continue', async () => {
    startWorkflow.mockRejectedValueOnce(new Error('busy'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const registry = fakeRegistry([row({ prefix: 'a/x' }), row({ prefix: 'a/y' })]);
    const out = await autoClear(env, registry);
    expect(startWorkflow).toHaveBeenCalledTimes(2);
    expect(out).toHaveLength(1);
    err.mockRestore();
  });
});
