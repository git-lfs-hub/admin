import { describe, test, expect, vi, beforeEach } from 'vitest';

import { autoArchive } from '@/gc/autoArchive';
import { isoNow, isoAddDays } from '@/lib/time';

const blockRepo = vi.fn(async () => {});
const env = { GC: { autoArchiveDays: 7 }, LFS_SERVER: { blockRepo } } as any;

function fakeRegistry(unused: unknown[], lastFullScanAt: string | null = isoNow()) {
  return {
    getLastFullScanAt: vi.fn(async () => lastFullScanAt),
    listStorageByStatus: vi.fn(async () => unused),
    block: vi.fn(async (prefix: string) => ({ prefix, archivedAt: isoNow() })),
  } as any;
}

const daysAgo = (n: number) => isoAddDays(isoNow(), -n);
const row = (over: Record<string, unknown>) => ({
  prefix: 'a/r',
  status: 'unused',
  archivedAt: null,
  ...over,
});

beforeEach(() => blockRepo.mockReset());

describe('autoArchive', () => {
  test('grace elapsed → blockRepo then block (status untouched)', async () => {
    const registry = fakeRegistry([row({ unusedAt: daysAgo(8) })]); // 8 > autoArchiveDays 7
    const out = await autoArchive(env, registry);
    expect(blockRepo).toHaveBeenCalledWith('a', 'r');
    expect(registry.block).toHaveBeenCalledWith('a/r');
    expect(out).toHaveLength(1);
  });

  test('cold-start guard: no full scan recorded → nothing archived', async () => {
    const registry = fakeRegistry([row({ unusedAt: daysAgo(8) })], null);
    const out = await autoArchive(env, registry);
    expect(registry.listStorageByStatus).not.toHaveBeenCalled();
    expect(blockRepo).not.toHaveBeenCalled();
    expect(out).toEqual([]);
  });

  test('within grace → skipped', async () => {
    const registry = fakeRegistry([row({ unusedAt: daysAgo(1) })]);
    await autoArchive(env, registry);
    expect(blockRepo).not.toHaveBeenCalled();
    expect(registry.block).not.toHaveBeenCalled();
  });

  test('already blocked → skipped', async () => {
    const registry = fakeRegistry([row({ unusedAt: daysAgo(30), archivedAt: daysAgo(2) })]);
    await autoArchive(env, registry);
    expect(blockRepo).not.toHaveBeenCalled();
  });

  test('no unusedAt → skipped', async () => {
    const registry = fakeRegistry([row({ unusedAt: null })]);
    await autoArchive(env, registry);
    expect(blockRepo).not.toHaveBeenCalled();
  });

  test('RPC failure → not blocked, no throw, continues', async () => {
    blockRepo.mockRejectedValueOnce(new Error('rpc down'));
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const registry = fakeRegistry([
      row({ prefix: 'a/x', unusedAt: daysAgo(8) }),
      row({ prefix: 'a/y', unusedAt: daysAgo(8) }),
    ]);
    const out = await autoArchive(env, registry);
    expect(registry.block).toHaveBeenCalledTimes(1); // only the second succeeded
    expect(registry.block).toHaveBeenCalledWith('a/y');
    expect(out).toHaveLength(1);
    warn.mockRestore();
  });
});
