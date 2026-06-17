import { reconcileLocal } from '@dev/reconcileLocal';
import { describe, test, expect, vi, beforeEach } from 'vitest';

const unblockRepo = vi.fn(async () => {});
const env = { LFS_SERVER: { unblockRepo } } as any;

function fakeRegistry() {
  return {
    lastInput: null as { activeOrgs: Set<string>; activeRepos: Set<string> } | null,
    unblock: vi.fn(async (prefix: string) => ({ prefix })),
    recordReconciliation: vi.fn(async function (this: any, input: any) {
      this.lastInput = input;
      return { missing: [], reappeared: [] };
    }),
    reconcileStorage: vi.fn(async () => ({
      becameUnused: [],
      becameUsed: [],
      blockedReused: [],
    })),
    listStorage: vi.fn(async () => []),
    syncLinks: vi.fn(async () => {}),
  } as any;
}

beforeEach(() => unblockRepo.mockReset());

describe('reconcileLocal', () => {
  test('present list → activeRepos; their owners → activeOrgs (lowercased)', async () => {
    const registry = fakeRegistry();
    const fullScan = await reconcileLocal(env, registry, ['ACME/Keep', 'globex/site']);
    expect(registry.lastInput).toEqual({
      activeOrgs: new Set(['acme', 'globex']),
      activeRepos: new Set(['acme/keep', 'globex/site']),
    });
    expect(registry.reconcileStorage).toHaveBeenCalledOnce();
    expect(fullScan).toBe(true); // fixture is authoritative → full scan
  });

  test('seeds a 1:1 link for a present repo backed by a storage prefix, skips orphans', async () => {
    const registry = fakeRegistry();
    registry.listStorage = vi.fn(async () => [{ prefix: 'ACME/Keep' }, { prefix: 'orphan/x' }]);
    await reconcileLocal(env, registry, ['acme/keep']);
    expect(registry.syncLinks).toHaveBeenCalledWith('acme', 'keep', new Set(['ACME/Keep']));
    expect(registry.syncLinks).toHaveBeenCalledTimes(1); // orphan prefix has no present repo
  });

  test('empty present list → every discovered repo evaluated as gone', async () => {
    const registry = fakeRegistry();
    await reconcileLocal(env, registry, []);
    expect(registry.lastInput?.activeRepos).toEqual(new Set());
    expect(registry.recordReconciliation).toHaveBeenCalledOnce();
  });
});
