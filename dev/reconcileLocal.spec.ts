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
    markFullScan: vi.fn(async () => {}),
  } as any;
}

beforeEach(() => unblockRepo.mockReset());

describe('reconcileLocal', () => {
  test('present list → activeRepos; their owners → activeOrgs (lowercased)', async () => {
    const registry = fakeRegistry();
    await reconcileLocal(env, registry, ['ACME/Keep', 'globex/site']);
    expect(registry.lastInput).toEqual({
      activeOrgs: new Set(['acme', 'globex']),
      activeRepos: new Set(['acme/keep', 'globex/site']),
    });
    expect(registry.reconcileStorage).toHaveBeenCalledOnce();
    expect(registry.markFullScan).toHaveBeenCalledOnce(); // fixture certifies the pass
  });

  test('empty present list → every discovered repo evaluated as gone', async () => {
    const registry = fakeRegistry();
    await reconcileLocal(env, registry, []);
    expect(registry.lastInput?.activeRepos).toEqual(new Set());
    expect(registry.recordReconciliation).toHaveBeenCalledOnce();
  });
});
