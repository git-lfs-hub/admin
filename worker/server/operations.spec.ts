import { describe, test, expect, vi, beforeEach } from 'vitest';

import { notify } from '@/alerts/lifecycle';
import { archive, restore, purgeServer, unblockServer } from '@/server/operations';
import { startWorkflow } from '@/workflows/lifecycle';

// notify hits ALERTS (a DO); stub it so these stay pure unit tests of the RPC + REGISTRY wiring.
// `restingAlert` is pure (row → kind) — keep the real one so restore picks the right kind.
vi.mock('@/alerts/lifecycle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/alerts/lifecycle')>()),
  notify: vi.fn(async () => {}),
}));

// startWorkflow reserves an op on the STORAGE DO + creates a Workflow instance; stub it so the
// cold-storage backup trigger is observable without real bindings.
vi.mock('@/workflows/lifecycle', () => ({
  startWorkflow: vi.fn(async () => 'backup-1'),
}));

beforeEach(() => vi.clearAllMocks());

function lfsEnv(over: Record<string, unknown> = {}) {
  return {
    GC: undefined,
    LFS_SERVER: {
      blockRepo: vi.fn(async () => {}),
      unblockRepo: vi.fn(async () => {}),
      purgeRepo: vi.fn(async () => {}),
      ...over,
    },
  } as any;
}

describe('archive', () => {
  test('blocks server then registry, notifies, returns the row', async () => {
    const env = lfsEnv();
    const row = { prefix: 'a/r' };
    const registry = { block: vi.fn(async () => row) } as any;
    expect(await archive(env, registry, 'a/r')).toBe(row);
    expect(env.LFS_SERVER.blockRepo).toHaveBeenCalledWith('a', 'r');
    expect(registry.block).toHaveBeenCalledWith('a/r');
    expect(notify).toHaveBeenCalledWith(env, 'a', 'r', 'archived');
  });

  test('registry refusal → null, no notify', async () => {
    const registry = { block: vi.fn(async () => null) } as any;
    expect(await archive(lfsEnv(), registry, 'a/r')).toBeNull();
    expect(notify).not.toHaveBeenCalled();
  });

  // Cold storage on → back up the freshly-blocked prefix immediately, not at the next cron tick.
  test('cold storage on → starts a backup for the blocked prefix', async () => {
    const env = lfsEnv();
    env.GC = { coldStorage: 'r2-cold' };
    const registry = { block: vi.fn(async () => ({ prefix: 'a/r' })) } as any;
    await archive(env, registry, 'a/r');
    expect(startWorkflow).toHaveBeenCalledWith(env, 'backup', { prefix: 'a/r' });
  });

  test('cold storage off → no backup', async () => {
    const registry = { block: vi.fn(async () => ({ prefix: 'a/r' })) } as any;
    await archive(lfsEnv(), registry, 'a/r');
    expect(startWorkflow).not.toHaveBeenCalled();
  });

  // The direct-purge path archives with `backup: false`: the cold copy is about to be deleted.
  test('backup: false → no backup even with cold storage on', async () => {
    const env = lfsEnv();
    env.GC = { coldStorage: 'r2-cold' };
    const registry = { block: vi.fn(async () => ({ prefix: 'a/r' })) } as any;
    await archive(env, registry, 'a/r', { backup: false });
    expect(startWorkflow).not.toHaveBeenCalled();
  });

  // The block already landed; a busy/failed backup start must not fail the archive.
  test('cold storage on but backup start fails → swallowed, still returns the row', async () => {
    const env = lfsEnv();
    env.GC = { coldStorage: 'r2-cold' };
    const row = { prefix: 'a/r' };
    const registry = { block: vi.fn(async () => row) } as any;
    vi.mocked(startWorkflow).mockRejectedValueOnce(new Error('busy'));
    expect(await archive(env, registry, 'a/r')).toBe(row);
  });

  // RPC before write: a failed blockRepo must propagate before REGISTRY is touched.
  test('propagates the RPC failure, leaves registry untouched', async () => {
    const env = lfsEnv({
      blockRepo: vi.fn(async () => {
        throw new Error('rpc down');
      }),
    });
    const registry = { block: vi.fn() } as any;
    await expect(archive(env, registry, 'a/r')).rejects.toThrow('rpc down');
    expect(registry.block).not.toHaveBeenCalled();
  });
});

describe('restore', () => {
  test('unblocks server then registry, notifies restored when back in use, returns the row', async () => {
    const env = lfsEnv();
    const row = { prefix: 'a/r', status: 'used' };
    const registry = { unblock: vi.fn(async () => row) } as any;
    expect(await restore(env, registry, 'a/r')).toBe(row);
    expect(env.LFS_SERVER.unblockRepo).toHaveBeenCalledWith('a', 'r');
    expect(registry.unblock).toHaveBeenCalledWith('a/r');
    expect(notify).toHaveBeenCalledWith(env, 'a', 'r', 'restored');
  });

  // Unblocking a prefix whose repo is still gone leaves it `unused`, so report `missing`, not
  // `restored` — serving hasn't actually resumed.
  test('notifies missing when the repo is still gone (unused)', async () => {
    const env = lfsEnv();
    const registry = { unblock: vi.fn(async () => ({ prefix: 'a/r', status: 'unused' })) } as any;
    await restore(env, registry, 'a/r');
    expect(notify).toHaveBeenCalledWith(env, 'a', 'r', 'missing');
  });

  test('not blocked → null, no notify', async () => {
    const registry = { unblock: vi.fn(async () => null) } as any;
    expect(await restore(lfsEnv(), registry, 'a/r')).toBeNull();
    expect(notify).not.toHaveBeenCalled();
  });

  test('propagates the RPC failure, leaves registry untouched', async () => {
    const env = lfsEnv({
      unblockRepo: vi.fn(async () => {
        throw new Error('rpc down');
      }),
    });
    const registry = { unblock: vi.fn() } as any;
    await expect(restore(env, registry, 'a/r')).rejects.toThrow('rpc down');
    expect(registry.unblock).not.toHaveBeenCalled();
  });
});

describe('purgeServer', () => {
  test('splits the prefix into owner/repo and calls purgeRepo', async () => {
    const env = lfsEnv();
    await purgeServer(env, 'a/r');
    expect(env.LFS_SERVER.purgeRepo).toHaveBeenCalledWith('a', 'r');
  });

  // RPC-after-write: a failed purgeRepo must propagate so the caller leaves its row unchanged.
  test('propagates the RPC failure', async () => {
    const env = lfsEnv({
      purgeRepo: vi.fn(async () => {
        throw new Error('rpc down');
      }),
    });
    await expect(purgeServer(env, 'a/r')).rejects.toThrow('rpc down');
  });
});

describe('unblockServer', () => {
  test('splits the prefix into owner/repo and calls unblockRepo', async () => {
    const env = lfsEnv();
    await unblockServer(env, 'a/r');
    expect(env.LFS_SERVER.unblockRepo).toHaveBeenCalledWith('a', 'r');
  });

  // RPC-before-write: a failed unblockRepo must propagate so the workflow step retries.
  test('propagates the RPC failure', async () => {
    const env = lfsEnv({
      unblockRepo: vi.fn(async () => {
        throw new Error('rpc down');
      }),
    });
    await expect(unblockServer(env, 'a/r')).rejects.toThrow('rpc down');
  });
});
