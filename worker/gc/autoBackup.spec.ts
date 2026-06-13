import { beforeEach, describe, expect, test, vi } from 'vitest';

import { autoBackup } from '@/gc/autoBackup';

const startWorkflow = vi.fn(async (..._a: unknown[]) => 'backup-id');
vi.mock('@/workflows/lifecycle', () => ({
  startWorkflow: (...a: unknown[]) => startWorkflow(...a),
}));

const cold = { GC: { coldStorage: 's3.backup' } } as unknown as CloudflareBindings;
const off = { GC: {} } as unknown as CloudflareBindings;

function fakeRegistry(rows: unknown[]) {
  return { listStorage: vi.fn(async () => rows) } as never;
}

const row = (over: Record<string, unknown>) => ({
  prefix: 'a/r',
  status: 'used',
  archivedAt: '2026-01-01T00:00:00Z', // blocked by default
  clearedAt: null,
  backupComplete: false,
  activeOp: null,
  ...over,
});

beforeEach(() => vi.clearAllMocks());

describe('autoBackup', () => {
  test('cold storage off → no-op', async () => {
    expect(await autoBackup(off, fakeRegistry([row({})]))).toEqual([]);
    expect(startWorkflow).not.toHaveBeenCalled();
  });

  test('blocked + no complete cold copy → starts a backup', async () => {
    const out = await autoBackup(cold, fakeRegistry([row({})]));
    expect(startWorkflow).toHaveBeenCalledWith(cold, 'backup', {
      prefix: 'a/r',
    });
    expect(out).toHaveLength(1);
  });

  test.each([
    ['not blocked', { archivedAt: null }],
    ['live already cleared', { clearedAt: '2026-02-01T00:00:00Z' }],
    ['complete cold copy exists', { backupComplete: true }],
    ['an op is already running', { activeOp: 'backup' }],
    ['purged', { status: 'purged' }],
  ])('skips: %s', async (_label, over) => {
    await autoBackup(cold, fakeRegistry([row(over)]));
    expect(startWorkflow).not.toHaveBeenCalled();
  });

  test('caps instances started per tick', async () => {
    const rows = Array.from({ length: 15 }, (_, i) => row({ prefix: `a/r${i}` }));
    const out = await autoBackup(cold, fakeRegistry(rows));
    expect(out).toHaveLength(10);
    expect(startWorkflow).toHaveBeenCalledTimes(10);
  });
});
