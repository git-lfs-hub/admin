import { describe, expect, test, vi } from 'vitest';

import { startWorkflow, terminateWorkflow } from '@/workflows/lifecycle';

describe('startWorkflow', () => {
  test('reserves the op then creates the instance with a fresh id', async () => {
    const beginOp = vi.fn(async () => {});
    const create = vi.fn(async () => {});
    const env = {
      STORAGE: { getByName: () => ({ beginOp }) },
      BACKUP_WORKFLOW: { create },
    } as unknown as CloudflareBindings;
    const params = { prefix: 'a/r' };
    const id = await startWorkflow(env, 'backup', params);
    expect(id).toMatch(/^backup-[0-9a-f-]{36}$/);
    expect(beginOp).toHaveBeenCalledWith('a/r', id, 'backup');
    expect(create).toHaveBeenCalledWith({ id, params });
  });

  // A rerun on the same prefix must get a fresh id — a deterministic id collides with the prior
  // (completed) instance, which Cloudflare keeps forever and refuses to recreate.
  test('reruns on the same prefix get distinct ids', async () => {
    const create = vi.fn(async () => {});
    const env = {
      STORAGE: { getByName: () => ({ beginOp: async () => {} }) },
      PURGE_WORKFLOW: { create },
    } as unknown as CloudflareBindings;
    const params = { prefix: 'a/r', scope: 'storage:a/r', triggeredBy: 'admin' as const };
    const first = await startWorkflow(env, 'purge', params);
    const second = await startWorkflow(env, 'purge', params);
    expect(second).not.toBe(first);
  });
});

describe('terminateWorkflow', () => {
  const envWith = (
    activeInstanceId: () => Promise<string | null>,
    get: ReturnType<typeof vi.fn> = vi.fn(async () => ({ terminate: vi.fn() })),
    endOp = vi.fn(async () => {}),
  ) => {
    const env = {
      STORAGE: { getByName: () => ({ activeInstanceId, endOp }) },
      PURGE_WORKFLOW: { get },
    } as unknown as CloudflareBindings;
    return { env, get, endOp };
  };

  test('active instance → terminates it then closes the op', async () => {
    const terminate = vi.fn();
    const { env, get, endOp } = envWith(
      async () => 'purge-a/r',
      vi.fn(async () => ({ terminate })),
    );
    await terminateWorkflow(env, 'purge', 'a/r', 'used');
    expect(get).toHaveBeenCalledWith('purge-a/r');
    expect(terminate).toHaveBeenCalled();
    expect(endOp).toHaveBeenCalledWith('a/r', 'purge-a/r', 'terminated', 'used');
  });

  test('no active instance → no-op', async () => {
    const { env, get, endOp } = envWith(async () => null);
    await terminateWorkflow(env, 'purge', 'a/r', 'used');
    expect(get).not.toHaveBeenCalled();
    expect(endOp).not.toHaveBeenCalled();
  });

  // A run that already finished/terminated → `terminate()` throws; swallow it and still close the op.
  test('terminate throws (already gone) → still closes the op', async () => {
    const { env, endOp } = envWith(
      async () => 'purge-a/r',
      vi.fn(async () => ({
        terminate: () => {
          throw new Error('not found');
        },
      })),
    );
    await terminateWorkflow(env, 'purge', 'a/r', 'unused');
    expect(endOp).toHaveBeenCalledWith('a/r', 'purge-a/r', 'terminated', 'unused');
  });
});
