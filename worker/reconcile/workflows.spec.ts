import { beforeEach, describe, expect, test, vi } from 'vitest';

import { reconcileWorkflows } from '@/reconcile/workflows';

// Storage DO stub: `activeInstanceId` resolves the open op row, `endOp` closes it.
const activeInstanceId = vi.fn(async (..._a: unknown[]) => 'backup-abc' as string | null);
const endOp = vi.fn(async (..._a: unknown[]) => {});
vi.mock('@/db/storage', () => ({
  Storage: { byPrefix: () => ({ activeInstanceId, endOp }) },
}));

const status = vi.fn(async () => ({ status: 'running' as string }));
const get = vi.fn(async () => ({ status }));
vi.mock('@/workflows/lifecycle', () => ({
  workflowFor: () => ({ get }),
}));

const setActiveOp = vi.fn(async (..._a: unknown[]) => {});
function fakeRegistry(rows: unknown[]) {
  return { listStorage: vi.fn(async () => rows), setActiveOp } as never;
}

const row = (over: Record<string, unknown> = {}) => ({
  prefix: 'a/r',
  status: 'used',
  activeOp: 'backup',
  ...over,
});

const env = {} as CloudflareBindings;

beforeEach(() => {
  vi.clearAllMocks();
  activeInstanceId.mockResolvedValue('backup-abc');
});

describe('reconcileWorkflows', () => {
  test('no active op → skipped', async () => {
    await reconcileWorkflows(env, fakeRegistry([row({ activeOp: null })]));
    expect(activeInstanceId).not.toHaveBeenCalled();
    expect(endOp).not.toHaveBeenCalled();
  });

  test('live instance (running) → left alone', async () => {
    status.mockResolvedValueOnce({ status: 'running' });
    await reconcileWorkflows(env, fakeRegistry([row()]));
    expect(endOp).not.toHaveBeenCalled();
  });

  test.each([['errored'], ['terminated']])(
    'dead instance (%s) → op closed, resting status kept',
    async (state) => {
      status.mockResolvedValueOnce({ status: state });
      await reconcileWorkflows(env, fakeRegistry([row()]));
      expect(endOp).toHaveBeenCalledWith('a/r', 'backup-abc', state, 'used');
    },
  );

  test('instance gone (lookup throws) → closed as errored', async () => {
    get.mockRejectedValueOnce(new Error('not found'));
    await reconcileWorkflows(env, fakeRegistry([row()]));
    expect(endOp).toHaveBeenCalledWith('a/r', 'backup-abc', 'errored', 'used');
  });

  test('flag set but no open op row → stale flag cleared', async () => {
    activeInstanceId.mockResolvedValueOnce(null);
    await reconcileWorkflows(env, fakeRegistry([row()]));
    expect(setActiveOp).toHaveBeenCalledWith('a/r', null);
    expect(endOp).not.toHaveBeenCalled();
  });
});
