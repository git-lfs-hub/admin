import type { WorkflowStep } from 'cloudflare:workers';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { purgeServer } from '@/server/operations';
import { PurgeWorkflow } from '@/workflows/purge';

// Gate + RPC cleanup are covered by their own units (confirm.spec, operations.spec) — stub them so
// the test drives PurgeWorkflow.run's own logic: the guard re-read and the R2 cursor-walk delete loop.
vi.mock('@/workflows/confirm', () => ({ runConfirmation: vi.fn(async () => {}) }));
vi.mock('@/server/operations', () => ({ purgeServer: vi.fn(async () => {}) }));

// Cold-storage S3 pass — stubbed so the cold test drives only the walk + delete wiring.
const listS3Page =
  vi.fn<(...a: unknown[]) => Promise<{ objects: { key: string }[]; cursor?: string }>>();
const s3DeleteObject = vi.fn<(...a: unknown[]) => Promise<void>>();
vi.mock('@/s3/list', () => ({
  listS3Page: (env: unknown, prefix: unknown, cursor: unknown) => listS3Page(env, prefix, cursor),
}));
vi.mock('@/s3/delete', () => ({
  s3DeleteObject: (env: unknown, key: unknown) => s3DeleteObject(env, key),
}));

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

function envWith(
  b: ReturnType<typeof bucket>,
  storageRow: unknown,
  endPurgeOp = vi.fn(async () => {}),
) {
  return {
    LFS_BUCKET: b,
    GC: { confirmDays: 3 }, // read into runConfirmation's args before the (mocked) call
    REGISTRY: { getByName: () => ({ getStorage: vi.fn(async () => storageRow) }) },
    STORAGE: { getByName: () => ({ endPurgeOp }) },
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
    const endPurgeOp = vi.fn(async () => {});
    const env = envWith(b, archived, endPurgeOp);
    const { step, calls } = fakeStep();

    await run(env, step);

    expect(b.list).toHaveBeenCalledWith({ prefix: 'A/R/' });
    expect(b.delete).toHaveBeenCalledWith(['A/R/o1', 'A/R/o2']);
    expect(purgeServer).toHaveBeenCalledWith(env, 'A/R');
    expect(endPurgeOp).toHaveBeenCalledWith('A/R', 'purge-abc123');
    expect(calls).toEqual(['begin', 'r2-delete:0', 'server-cleanup', 'finish']);
  });

  test('walks the cursor across pages until exhausted', async () => {
    const b = bucket([{ keys: ['A/R/o1'], cursor: 'c1' }, { keys: ['A/R/o2'] }]);
    const { step, calls } = fakeStep();

    await run(envWith(b, archived), step);

    expect(b.list).toHaveBeenNthCalledWith(1, { prefix: 'A/R/' });
    expect(b.list).toHaveBeenNthCalledWith(2, { prefix: 'A/R/', cursor: 'c1' });
    expect(b.delete).toHaveBeenCalledTimes(2);
    expect(calls).toContain('r2-delete:1');
  });

  test('empty bucket → no delete, still cleans server + ends op', async () => {
    const b = bucket([{ keys: [] }]);
    const endPurgeOp = vi.fn(async () => {});
    const env = envWith(b, archived, endPurgeOp);
    const { step } = fakeStep();

    await run(env, step);

    expect(b.delete).not.toHaveBeenCalled();
    expect(purgeServer).toHaveBeenCalledWith(env, 'A/R');
    expect(endPurgeOp).toHaveBeenCalledWith('A/R', 'purge-abc123');
  });

  test('cold storage on → also deletes the cold S3 copy, between R2 delete and server-cleanup', async () => {
    listS3Page.mockResolvedValue({ objects: [{ key: 'A/R/o1' }, { key: 'A/R/o2' }] });
    const b = bucket([{ keys: ['A/R/o1'] }]);
    const env = envWith(b, archived);
    (env as { GC: unknown }).GC = { confirmDays: 3, coldStorage: 's3.backup' };
    const { step, calls } = fakeStep();

    await run(env, step);

    expect(s3DeleteObject).toHaveBeenCalledWith(env, 'A/R/o1');
    expect(s3DeleteObject).toHaveBeenCalledWith(env, 'A/R/o2');
    expect(calls).toEqual(['begin', 'r2-delete:0', 's3-delete:0', 'server-cleanup', 'finish']);
  });

  test('cold storage off → no S3 pass', async () => {
    const b = bucket([{ keys: ['A/R/o1'] }]);
    const { step, calls } = fakeStep();

    await run(envWith(b, archived), step);

    expect(listS3Page).not.toHaveBeenCalled();
    expect(s3DeleteObject).not.toHaveBeenCalled();
    expect(calls).not.toContain('s3-delete:0');
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
