import type { WorkflowStep } from 'cloudflare:workers';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { DeleteBackupWorkflow, startDeleteBackup } from '@/workflows/deleteBackup';
import { workflowInstanceId } from '@/workflows/instanceId';

// s3DeleteObject + listS3Page are covered by their own units — stub them so the test drives the
// workflow's own logic: the eligibility re-read, the cold-storage cursor-walk, and the finish handoff.
type S3Page = { prefix: string; objects: { key: string; storageClass: string }[]; cursor?: string };
const listS3Page = vi.fn<(...a: unknown[]) => Promise<S3Page>>();
const s3DeleteObject = vi.fn<(...a: unknown[]) => Promise<void>>();
vi.mock('@/s3/list', () => ({
  listS3Page: (env: unknown, prefix: unknown, cursor: unknown) => listS3Page(env, prefix, cursor),
}));
vi.mock('@/s3/delete', () => ({
  s3DeleteObject: (env: unknown, key: unknown) => s3DeleteObject(env, key),
}));

const event = { payload: { prefix: 'A/R' }, instanceId: 'deleteBackup-abc' };

function envWith(storageRow: unknown, endDeleteBackupOp = vi.fn(async () => {})) {
  return {
    env: {
      REGISTRY: { getByName: () => ({ getStorage: vi.fn(async () => storageRow) }) },
      STORAGE: { getByName: () => ({ endDeleteBackupOp }) },
    } as unknown as CloudflareBindings,
    endDeleteBackupOp,
  };
}

// step.do runs the body and records names so ordering is assertable.
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
  new DeleteBackupWorkflow({} as never, env).run(event as never, step);

const eligible = { status: 'unused', backedUpAt: '2026-02-01T00:00:00Z', clearedAt: null };

const obj = (key: string) => ({ key, storageClass: 'GLACIER_IR' });

describe('DeleteBackupWorkflow.run', () => {
  beforeEach(() => vi.clearAllMocks());

  test('deletes every cold object, then finishes (in order)', async () => {
    listS3Page.mockResolvedValue({ prefix: 'A/R/', objects: [obj('A/R/o1'), obj('A/R/o2')] });
    const { env, endDeleteBackupOp } = envWith(eligible);
    const { step, calls } = fakeStep();

    await run(env, step);

    expect(listS3Page).toHaveBeenCalledWith(env, 'A/R/', undefined);
    expect(s3DeleteObject).toHaveBeenCalledWith(env, 'A/R/o1');
    expect(s3DeleteObject).toHaveBeenCalledWith(env, 'A/R/o2');
    expect(endDeleteBackupOp).toHaveBeenCalledWith('A/R', 'deleteBackup-abc');
    expect(calls).toEqual(['begin', 'delete:0', 'finish']);
  });

  test('walks the cursor across pages until exhausted', async () => {
    listS3Page
      .mockResolvedValueOnce({ prefix: 'A/R/', objects: [obj('A/R/o1')], cursor: 'c1' })
      .mockResolvedValueOnce({ prefix: 'A/R/', objects: [obj('A/R/o2')] });
    const { env } = envWith(eligible);
    const { step, calls } = fakeStep();

    await run(env, step);

    expect(listS3Page).toHaveBeenNthCalledWith(2, env, 'A/R/', 'c1');
    expect(s3DeleteObject).toHaveBeenCalledTimes(2);
    expect(calls).toContain('delete:1');
  });

  test.each([
    ['no backup', { status: 'unused', backedUpAt: null, clearedAt: null }],
    ['cleared (cold is only copy)', { status: 'unused', backedUpAt: 'x', clearedAt: 'y' }],
    ['row gone', null],
  ])('ineligible (%s) → throws, nothing listed', async (_label, row) => {
    const { env } = envWith(row);
    const { step } = fakeStep();
    await expect(run(env, step)).rejects.toThrow('delete-backup no longer eligible');
    expect(listS3Page).not.toHaveBeenCalled();
  });
});

describe('startDeleteBackup', () => {
  test('reserves the op then creates the instance with the deterministic id', async () => {
    const beginOp = vi.fn(async () => {});
    const create = vi.fn(async () => {});
    const env = {
      STORAGE: { getByName: () => ({ beginOp }) },
      DELETE_BACKUP_WORKFLOW: { create },
    } as unknown as CloudflareBindings;
    const params = { prefix: 'a/r' };
    const id = await startDeleteBackup(env, params);
    const expected = workflowInstanceId('deleteBackup', 'a/r');
    expect(id).toBe(expected);
    expect(beginOp).toHaveBeenCalledWith('a/r', expected, 'deleteBackup');
    expect(create).toHaveBeenCalledWith({ id: expected, params });
  });
});
