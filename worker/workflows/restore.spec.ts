import type { WorkflowStep } from 'cloudflare:workers';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { workflowInstanceId } from '@/workflows/instanceId';
import { RestoreWorkflow, startRestore } from '@/workflows/restore';

// The S3 / RPC / DO units are covered on their own — stub them so the test drives the workflow's
// own logic: the eligibility re-read, the list cursor-walk, the per-tier thaw loop, and the
// unblock → finish handoff.
type S3Page = { prefix: string; objects: { key: string; storageClass: string }[]; cursor?: string };
const listS3Page = vi.fn<(...a: unknown[]) => Promise<S3Page>>();
const copyS3toR2 = vi.fn<(...a: unknown[]) => Promise<void>>();
const s3RestoreObject = vi.fn<(...a: unknown[]) => Promise<void>>();
const s3HeadRestored = vi.fn<(...a: unknown[]) => Promise<boolean>>();
vi.mock('@/s3/list', () => ({
  listS3Page: (env: unknown, prefix: unknown, cursor: unknown) => listS3Page(env, prefix, cursor),
}));
vi.mock('@/s3/restore', () => ({
  copyS3toR2: (env: unknown, key: unknown) => copyS3toR2(env, key),
  s3RestoreObject: (env: unknown, key: unknown) => s3RestoreObject(env, key),
  s3HeadRestored: (env: unknown, key: unknown) => s3HeadRestored(env, key),
}));
const unblockServer = vi.fn<(...a: unknown[]) => Promise<void>>();
vi.mock('@/server/operations', () => ({
  unblockServer: (env: unknown, prefix: unknown) => unblockServer(env, prefix),
}));

const event = { payload: { prefix: 'A/R' }, instanceId: 'restore-abc' };

function envWith(storageRow: unknown, endRestoreOp = vi.fn(async () => {})) {
  return {
    env: {
      REGISTRY: { getByName: () => ({ getStorage: vi.fn(async () => storageRow) }) },
      STORAGE: { getByName: () => ({ endRestoreOp }) },
    } as unknown as CloudflareBindings,
    endRestoreOp,
  };
}

// step.do runs the body + records names; step.sleep just records (no real wait).
function fakeStep() {
  const calls: string[] = [];
  return {
    calls,
    step: {
      do: async (name: string, cb: () => Promise<unknown>) => {
        calls.push(name);
        return cb();
      },
      sleep: async (name: string) => {
        calls.push(`sleep:${name}`);
      },
    } as unknown as WorkflowStep,
  };
}

const run = (env: CloudflareBindings, step: WorkflowStep) =>
  new RestoreWorkflow({} as never, env).run(event as never, step);

const cleared = {
  status: 'unused',
  archivedAt: '2026-01-01T00:00:00Z',
  clearedAt: '2026-02-01T00:00:00Z',
};

const irObj = (key: string) => ({ key, storageClass: 'GLACIER_IR' });

describe('RestoreWorkflow.run', () => {
  beforeEach(() => vi.clearAllMocks());

  test('GLACIER_IR page: thaw (no-op) → ready at once (no sleep) → pull all, then unblock + finish', async () => {
    listS3Page.mockResolvedValue({ prefix: 'A/R/', objects: [irObj('A/R/o1'), irObj('A/R/o2')] });
    const { env, endRestoreOp } = envWith(cleared);
    const { step, calls } = fakeStep();

    await run(env, step);

    expect(listS3Page).toHaveBeenCalledWith(env, 'A/R/', undefined); // re-listed per sub-step
    expect(s3RestoreObject).not.toHaveBeenCalled(); // GLACIER_IR needs no thaw
    expect(s3HeadRestored).not.toHaveBeenCalled(); // poll filters colder → empty → ready, no sleep
    expect(copyS3toR2).toHaveBeenCalledWith(env, 'A/R/o1');
    expect(copyS3toR2).toHaveBeenCalledWith(env, 'A/R/o2');
    expect(unblockServer).toHaveBeenCalledWith(env, 'A/R');
    expect(endRestoreOp).toHaveBeenCalledWith('A/R', 'restore-abc');
    expect(calls).toEqual(['begin', 'thaw:0', 'poll:0:0', 'pull:0', 'unblock', 'finish']);
  });

  test('colder tier → thaw all → poll/sleep until ready → pull all', async () => {
    listS3Page.mockResolvedValue({
      prefix: 'A/R/',
      objects: [{ key: 'A/R/cold', storageClass: 'DEEP_ARCHIVE' }],
    });
    s3HeadRestored.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { env } = envWith(cleared);
    const { step, calls } = fakeStep();

    await run(env, step);

    expect(s3RestoreObject).toHaveBeenCalledWith(env, 'A/R/cold');
    expect(s3HeadRestored).toHaveBeenCalledTimes(2); // not-ready, then ready
    expect(copyS3toR2).toHaveBeenCalledWith(env, 'A/R/cold');
    expect(calls).toEqual([
      'begin',
      'thaw:0',
      'poll:0:0',
      'sleep:wait:0',
      'poll:1:0',
      'pull:0',
      'unblock',
      'finish',
    ]);
  });

  test('thaws every page before waiting (shared retrieval window), then pulls all', async () => {
    // Two colder pages; both must be thawed before the wait, and the wait scans both each tick.
    listS3Page.mockImplementation((_env: unknown, _prefix: unknown, cursor: unknown) =>
      Promise.resolve(
        cursor === 'c1'
          ? { prefix: 'A/R/', objects: [{ key: 'A/R/o2', storageClass: 'DEEP_ARCHIVE' }] }
          : {
              prefix: 'A/R/',
              objects: [{ key: 'A/R/o1', storageClass: 'DEEP_ARCHIVE' }],
              cursor: 'c1',
            },
      ),
    );
    s3HeadRestored.mockResolvedValue(true); // both ready on the first scan
    const { env } = envWith(cleared);
    const { step, calls } = fakeStep();

    await run(env, step);

    // Both pages thawed before the first poll, both polled before any pull.
    expect(calls).toEqual([
      'begin',
      'thaw:0',
      'thaw:1',
      'poll:0:0',
      'poll:0:1',
      'pull:0',
      'pull:1',
      'unblock',
      'finish',
    ]);
    expect(s3RestoreObject).toHaveBeenCalledWith(env, 'A/R/o1');
    expect(s3RestoreObject).toHaveBeenCalledWith(env, 'A/R/o2');
    expect(copyS3toR2).toHaveBeenCalledTimes(2);
    expect(listS3Page).toHaveBeenCalledWith(env, 'A/R/', 'c1'); // page 2 re-listed from the cursor
  });

  test('one page not ready → sleeps, re-scans all pages next tick', async () => {
    listS3Page.mockResolvedValue({
      prefix: 'A/R/',
      objects: [{ key: 'A/R/cold', storageClass: 'GLACIER' }],
    });
    // tick 0: not ready → sleep; tick 1: ready.
    s3HeadRestored.mockResolvedValueOnce(false).mockResolvedValue(true);
    const { env } = envWith(cleared);
    const { step, calls } = fakeStep();

    await run(env, step);

    expect(calls).toContain('sleep:wait:0');
    expect(calls.filter((c) => c.startsWith('poll:')).length).toBe(2); // poll:0:0, poll:1:0
  });

  test.each([
    ['purged', { status: 'purged', archivedAt: 'x', clearedAt: 'y' }],
    ['not blocked', { status: 'unused', archivedAt: null, clearedAt: 'y' }],
    ['not cleared', { status: 'unused', archivedAt: 'x', clearedAt: null }],
    ['row gone', null],
  ])('ineligible (%s) → throws, nothing listed', async (_label, row) => {
    const { env } = envWith(row);
    const { step } = fakeStep();
    await expect(run(env, step)).rejects.toThrow('restore no longer eligible');
    expect(listS3Page).not.toHaveBeenCalled();
  });
});

describe('startRestore', () => {
  test('reserves the op then creates the instance with the deterministic id', async () => {
    const beginOp = vi.fn(async () => {});
    const create = vi.fn(async () => {});
    const env = {
      STORAGE: { getByName: () => ({ beginOp }) },
      RESTORE_WORKFLOW: { create },
    } as unknown as CloudflareBindings;
    const params = { prefix: 'a/r' };
    const id = await startRestore(env, params);
    const expected = workflowInstanceId('restore', 'a/r');
    expect(id).toBe(expected);
    expect(beginOp).toHaveBeenCalledWith('a/r', expected, 'restore');
    expect(create).toHaveBeenCalledWith({ id: expected, params });
  });
});
