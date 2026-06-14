import type { WorkflowStep } from 'cloudflare:workers';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { RestoreWorkflow } from '@/workflows/restore';

// The S3 / RPC / DO units are covered on their own — stub them so the test drives the workflow's
// own logic: the eligibility re-read, the list cursor-walk, the per-tier thaw loop, and the
// unblock → finish handoff.
type S3Page = { prefix: string; objects: { key: string; storageClass: string }[]; cursor?: string };
const listS3Page = vi.fn<(...a: unknown[]) => Promise<S3Page>>();
const copyObject = vi.fn<(...a: unknown[]) => Promise<void>>();
const s3RestoreObject = vi.fn<(...a: unknown[]) => Promise<void>>();
const s3Ready = vi.fn<(...a: unknown[]) => Promise<boolean>>();
vi.mock('@/s3/list', () => ({
  listS3Page: (env: unknown, prefix: unknown, cursor: unknown) => listS3Page(env, prefix, cursor),
}));
vi.mock('@/s3/copy', () => ({
  copyObject: (key: unknown, src: unknown, dst: unknown) => copyObject(key, src, dst),
}));
vi.mock('@/s3/s3-store', () => ({ s3Store: () => 'S3' }));
vi.mock('@/s3/r2-store', () => ({ r2Store: () => 'R2' }));
vi.mock('@/s3/restore', async (importActual) => {
  const actual = await importActual<typeof import('@/s3/restore')>();
  return {
    ...actual,
    s3Ready: (env: unknown, o: unknown) => s3Ready(env, o),
    s3RestoreObject: (env: unknown, o: unknown) => s3RestoreObject(env, o),
  };
});
const unblockServer = vi.fn<(...a: unknown[]) => Promise<void>>();
vi.mock('@/server/operations', () => ({
  unblockServer: (env: unknown, prefix: unknown) => unblockServer(env, prefix),
}));

const event = { payload: { prefix: 'A/R' }, instanceId: 'restore-abc' };

function envWith(storageRow: unknown, endRestoreOp = vi.fn(async () => {})) {
  return {
    env: {
      REGISTRY: { getByName: () => ({ getStorage: vi.fn(async () => storageRow) }) },
      STORAGE: { getByName: () => ({ endRestoreOp, endOp: vi.fn(async () => {}) }) },
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
  beforeEach(() => {
    vi.clearAllMocks();
    s3Ready.mockResolvedValue(true);
  });

  test('GLACIER_IR page: thaw (no-op) → ready at once (no sleep) → pull all, then unblock + finish', async () => {
    listS3Page.mockResolvedValue({ prefix: 'A/R/', objects: [irObj('A/R/o1'), irObj('A/R/o2')] });
    const { env, endRestoreOp } = envWith(cleared);
    const { step, calls } = fakeStep();

    await run(env, step);

    expect(listS3Page).toHaveBeenCalledWith(env, 'A/R/', undefined); // re-listed per sub-step
    expect(s3RestoreObject).not.toHaveBeenCalled(); // GLACIER_IR needs no thaw
    expect(s3Ready).not.toHaveBeenCalled();
    expect(copyObject).toHaveBeenCalledWith('A/R/o1', 'S3', 'R2');
    expect(copyObject).toHaveBeenCalledWith('A/R/o2', 'S3', 'R2');
    expect(unblockServer).toHaveBeenCalledWith(env, 'A/R');
    expect(endRestoreOp).toHaveBeenCalledWith('A/R', 'restore-abc');
    expect(calls).toEqual([
      'begin',
      'thaw:0',
      'poll-thawed:0:0',
      'restore-obj:0',
      'unblock',
      'finish',
    ]);
  });

  test('STANDARD page: no thaw/poll, pull immediately (legacy or missing StorageClass)', async () => {
    listS3Page.mockResolvedValue({
      prefix: 'A/R/',
      objects: [{ key: 'A/R/o1', storageClass: 'STANDARD' }],
    });
    const { env } = envWith(cleared);
    const { step, calls } = fakeStep();

    await run(env, step);

    expect(s3RestoreObject).not.toHaveBeenCalled();
    expect(s3Ready).not.toHaveBeenCalled();
    expect(copyObject).toHaveBeenCalledWith('A/R/o1', 'S3', 'R2');
    expect(calls).toEqual([
      'begin',
      'thaw:0',
      'poll-thawed:0:0',
      'restore-obj:0',
      'unblock',
      'finish',
    ]);
  });

  test('colder tier → thaw all → poll/sleep until ready → pull all', async () => {
    listS3Page.mockResolvedValue({
      prefix: 'A/R/',
      objects: [{ key: 'A/R/cold', storageClass: 'DEEP_ARCHIVE' }],
    });
    s3Ready.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { env } = envWith(cleared);
    const { step, calls } = fakeStep();

    await run(env, step);

    expect(s3RestoreObject).toHaveBeenCalledWith(env, {
      key: 'A/R/cold',
      storageClass: 'DEEP_ARCHIVE',
    });
    expect(s3Ready).toHaveBeenCalledTimes(2); // poll:0 + poll:1
    expect(copyObject).toHaveBeenCalledWith('A/R/cold', 'S3', 'R2');
    expect(calls).toEqual([
      'begin',
      'thaw:0',
      'poll-thawed:0:0',
      'sleep:wait:0',
      'poll-thawed:1:0',
      'restore-obj:0',
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
    s3Ready.mockResolvedValue(true); // poll only
    const { env } = envWith(cleared);
    const { step, calls } = fakeStep();

    await run(env, step);

    // Both pages thawed before the first poll, both polled before any pull.
    expect(calls).toEqual([
      'begin',
      'thaw:0',
      'thaw:1',
      'poll-thawed:0:0',
      'poll-thawed:0:1',
      'restore-obj:0',
      'restore-obj:1',
      'unblock',
      'finish',
    ]);
    expect(s3RestoreObject).toHaveBeenCalledWith(env, {
      key: 'A/R/o1',
      storageClass: 'DEEP_ARCHIVE',
    });
    expect(s3RestoreObject).toHaveBeenCalledWith(env, {
      key: 'A/R/o2',
      storageClass: 'DEEP_ARCHIVE',
    });
    expect(copyObject).toHaveBeenCalledTimes(2);
    expect(listS3Page).toHaveBeenCalledWith(env, 'A/R/', 'c1'); // page 2 re-listed from the cursor
  });

  test('one page not ready → sleeps, re-scans all pages next tick', async () => {
    listS3Page.mockResolvedValue({
      prefix: 'A/R/',
      objects: [{ key: 'A/R/cold', storageClass: 'GLACIER' }],
    });
    // tick 0: not ready → sleep; tick 1: ready.
    s3Ready.mockResolvedValueOnce(false).mockResolvedValue(true);
    const { env } = envWith(cleared);
    const { step, calls } = fakeStep();

    await run(env, step);

    expect(calls).toContain('sleep:wait:0');
    expect(calls.filter((c) => c.startsWith('poll-thawed:')).length).toBe(2); // poll:0:0, poll:1:0
  });

  test('INTELLIGENT_TIERING archive → thaw with IT body → poll until restored', async () => {
    listS3Page.mockResolvedValue({
      prefix: 'A/R/',
      objects: [{ key: 'A/R/it', storageClass: 'INTELLIGENT_TIERING' }],
    });
    s3Ready.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { env } = envWith(cleared);
    const { step, calls } = fakeStep();

    await run(env, step);

    expect(s3RestoreObject).toHaveBeenCalledWith(env, {
      key: 'A/R/it',
      storageClass: 'INTELLIGENT_TIERING',
    });
    expect(s3Ready).toHaveBeenCalledTimes(2);
    expect(calls).toContain('sleep:wait:0');
  });

  test('INTELLIGENT_TIERING frequent tier → POST restore (403 no-op), poll ready at once', async () => {
    listS3Page.mockResolvedValue({
      prefix: 'A/R/',
      objects: [{ key: 'A/R/it', storageClass: 'INTELLIGENT_TIERING' }],
    });
    s3Ready.mockResolvedValue(true);
    const { env } = envWith(cleared);
    const { step, calls } = fakeStep();

    await run(env, step);

    expect(s3RestoreObject).toHaveBeenCalledWith(env, {
      key: 'A/R/it',
      storageClass: 'INTELLIGENT_TIERING',
    });
    expect(s3Ready).toHaveBeenCalledTimes(1); // poll only
    expect(calls).toEqual([
      'begin',
      'thaw:0',
      'poll-thawed:0:0',
      'restore-obj:0',
      'unblock',
      'finish',
    ]);
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
