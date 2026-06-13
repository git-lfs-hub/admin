import type { WorkflowStep } from 'cloudflare:workers';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { purgeServer } from '@/server/operations';
import { PurgeWorkflow, startPurge, wakePurge } from '@/workflows/purge';

// Gate + RPC cleanup are covered by their own units (confirm.spec, operations.spec) — stub them so
// the test drives PurgeWorkflow.run's own logic: the guard re-read and the R2 cursor-walk delete loop.
vi.mock('@/workflows/confirm', () => ({ runConfirmation: vi.fn(async () => {}) }));
vi.mock('@/server/operations', () => ({ purgeServer: vi.fn(async () => {}) }));

const archived = { status: 'unused', archivedAt: '2026-01-01T00:00:00Z' };

const event = {
  payload: { prefix: 'A/R', scope: 'storage:a/r', triggeredBy: 'admin' as const },
  instanceId: 'purge-abc123',
};

// One R2 list page per entry; `cursor` set ⇒ more pages follow (truncated).
function bucket(pages: Array<{ keys: string[]; cursor?: string }>) {
  return {
    list: vi.fn(async () => {
      const p = pages.shift()!;
      return {
        objects: p.keys.map((key) => ({ key })),
        truncated: p.cursor != null,
        cursor: p.cursor,
      };
    }),
    delete: vi.fn(async () => {}),
  };
}

function envWith(b: ReturnType<typeof bucket>, storageRow: unknown, endOp = vi.fn(async () => {})) {
  return {
    LFS_BUCKET: b,
    GC: { purgeConfirmDays: 3 }, // read into runConfirmation's args before the (mocked) call
    REGISTRY: { getByName: () => ({ getStorage: vi.fn(async () => storageRow) }) },
    STORAGE: { getByName: () => ({ endOp }) },
  } as unknown as CloudflareBindings;
}

// step.do just runs the body; record names to assert ordering.
function fakeStep() {
  const calls: string[] = [];
  return {
    calls,
    step: {
      do: async (name: string, cb: () => Promise<unknown>) => {
        calls.push(name);
        return cb();
      },
    } as unknown as WorkflowStep,
  };
}

const run = (env: CloudflareBindings, step: WorkflowStep) =>
  new PurgeWorkflow({} as never, env).run(event as never, step);

describe('PurgeWorkflow.run', () => {
  beforeEach(() => vi.clearAllMocks());

  test('eligible → deletes one page, cleans server, ends op purged (in order)', async () => {
    const b = bucket([{ keys: ['A/R/o1', 'A/R/o2'] }]);
    const endOp = vi.fn(async () => {});
    const env = envWith(b, archived, endOp);
    const { step, calls } = fakeStep();

    await run(env, step);

    expect(b.list).toHaveBeenCalledWith({ prefix: 'A/R/' });
    expect(b.delete).toHaveBeenCalledWith(['A/R/o1', 'A/R/o2']);
    expect(purgeServer).toHaveBeenCalledWith(env, 'A/R');
    expect(endOp).toHaveBeenCalledWith('A/R', 'purge-abc123', 'complete', 'purged');
    expect(calls).toEqual(['guard', 'delete:0', 'server-cleanup', 'finish']);
  });

  test('walks the cursor across pages until exhausted', async () => {
    const b = bucket([{ keys: ['A/R/o1'], cursor: 'c1' }, { keys: ['A/R/o2'] }]);
    const { step, calls } = fakeStep();

    await run(envWith(b, archived), step);

    expect(b.list).toHaveBeenNthCalledWith(1, { prefix: 'A/R/' });
    expect(b.list).toHaveBeenNthCalledWith(2, { prefix: 'A/R/', cursor: 'c1' });
    expect(b.delete).toHaveBeenCalledTimes(2);
    expect(calls).toContain('delete:1');
  });

  test('empty bucket → no delete, still cleans server + ends op', async () => {
    const b = bucket([{ keys: [] }]);
    const endOp = vi.fn(async () => {});
    const env = envWith(b, archived, endOp);
    const { step } = fakeStep();

    await run(env, step);

    expect(b.delete).not.toHaveBeenCalled();
    expect(purgeServer).toHaveBeenCalledWith(env, 'A/R');
    expect(endOp).toHaveBeenCalledWith('A/R', 'purge-abc123', 'complete', 'purged');
  });

  test('guard: repo no longer eligible → throws, nothing deleted', async () => {
    const b = bucket([]);
    const env = envWith(b, null);
    const { step } = fakeStep();

    await expect(run(env, step)).rejects.toThrow('purge no longer eligible');
    expect(b.list).not.toHaveBeenCalled();
    expect(purgeServer).not.toHaveBeenCalled();
  });
});

describe('startPurge', () => {
  test('reserves the op then creates the instance with a fresh id', async () => {
    const beginOp = vi.fn(async () => {});
    const create = vi.fn(async () => {});
    const env = {
      STORAGE: { getByName: () => ({ beginOp }) },
      PURGE_WORKFLOW: { create },
    } as any;
    const params = { prefix: 'a/r', scope: 'storage:a/r', triggeredBy: 'admin' as const };
    const id = await startPurge(env, params);
    expect(id).toMatch(/^purge-[0-9a-f-]{36}$/);
    expect(beginOp).toHaveBeenCalledWith('a/r', id, 'purge');
    expect(create).toHaveBeenCalledWith({ id, params });
  });
});

describe('wakePurge', () => {
  function wakeEnv(prefix: string | null, sendEvent = vi.fn(async () => {})) {
    return {
      env: {
        REGISTRY: {
          getByName: () => ({ storageForRepo: async () => (prefix ? { prefix } : null) }),
        },
        STORAGE: { getByName: () => ({ activeInstanceId: async () => 'purge-abc123' }) },
        PURGE_WORKFLOW: { get: async () => ({ sendEvent }) },
      } as any,
      sendEvent,
    };
  }

  test('maps scope → prefix and sends alert_purge to the instance', async () => {
    const { env: e, sendEvent } = wakeEnv('Alice/Repo');
    await wakePurge(e, 'storage:alice/repo', 'approve', 'slack:u');
    expect(sendEvent).toHaveBeenCalledWith({
      type: 'alert_purge',
      payload: { decision: 'approve', by: 'slack:u' },
    });
  });

  test('no matching storage row → no-op', async () => {
    const { env: e, sendEvent } = wakeEnv(null);
    await wakePurge(e, 'storage:alice/repo', 'cancel', 'slack:u');
    expect(sendEvent).not.toHaveBeenCalled();
  });

  test('gone instance (get throws) is swallowed', async () => {
    const e = {
      REGISTRY: { getByName: () => ({ storageForRepo: async () => ({ prefix: 'a/r' }) }) },
      STORAGE: { getByName: () => ({ activeInstanceId: async () => 'purge-abc123' }) },
      PURGE_WORKFLOW: {
        get: async () => {
          throw new Error('not found');
        },
      },
    } as any;
    await expect(wakePurge(e, 'storage:a/r', 'approve', 'u')).resolves.toBeUndefined();
  });
});
