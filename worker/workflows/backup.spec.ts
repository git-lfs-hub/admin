import type { WorkflowStep } from 'cloudflare:workers';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { BackupWorkflow, startBackup } from '@/workflows/backup';
import { workflowInstanceId } from '@/workflows/instanceId';

// copyR2toS3 is covered by its own unit (s3/backup.spec) — stub it so the test drives the workflow's
// own logic: the start-capture of `archivedAt`, the R2 cursor-walk, and the finish handoff.
const copyR2toS3 = vi.fn(async (..._a: unknown[]) => {});
vi.mock('@/s3/backup', () => ({
  copyR2toS3: (env: unknown, key: unknown, cls: unknown) => copyR2toS3(env, key, cls),
}));

const event = { payload: { prefix: 'A/R' }, instanceId: 'backup-abc' };

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
  };
}

function envWith(
  b: ReturnType<typeof bucket>,
  storageRow: unknown,
  endBackupOp = vi.fn(async () => {}),
) {
  return {
    env: {
      LFS_BUCKET: b,
      REGISTRY: { getByName: () => ({ getStorage: vi.fn(async () => storageRow) }) },
      STORAGE: { getByName: () => ({ endBackupOp }) },
    } as unknown as CloudflareBindings,
    endBackupOp,
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
  new BackupWorkflow({} as never, env).run(event as never, step);

const blocked = { status: 'used', archivedAt: '2026-01-01T00:00:00Z' };

describe('BackupWorkflow.run', () => {
  beforeEach(() => vi.clearAllMocks());

  test('copies every page, then finishes with the start `archivedAt` (in order)', async () => {
    const b = bucket([{ keys: ['A/R/o1', 'A/R/o2'] }]);
    const { env, endBackupOp } = envWith(b, blocked);
    const { step, calls } = fakeStep();

    await run(env, step);

    expect(b.list).toHaveBeenCalledWith({ prefix: 'A/R/' });
    expect(copyR2toS3).toHaveBeenCalledWith(env, 'A/R/o1', 'GLACIER_IR');
    expect(copyR2toS3).toHaveBeenCalledWith(env, 'A/R/o2', 'GLACIER_IR');
    expect(endBackupOp).toHaveBeenCalledWith('A/R', 'backup-abc', blocked.archivedAt);
    expect(calls).toEqual(['begin', 'copy:0', 'finish']);
  });

  test('walks the cursor across pages until exhausted', async () => {
    const b = bucket([{ keys: ['A/R/o1'], cursor: 'c1' }, { keys: ['A/R/o2'] }]);
    const { env } = envWith(b, blocked);
    const { step, calls } = fakeStep();

    await run(env, step);

    expect(b.list).toHaveBeenNthCalledWith(2, { prefix: 'A/R/', cursor: 'c1' });
    expect(copyR2toS3).toHaveBeenCalledTimes(2);
    expect(calls).toContain('copy:1');
  });

  test('started unblocked → finishes with archivedAt null (incomplete copy)', async () => {
    const b = bucket([{ keys: [] }]);
    const { env, endBackupOp } = envWith(b, { status: 'used', archivedAt: null });
    const { step } = fakeStep();

    await run(env, step);

    expect(copyR2toS3).not.toHaveBeenCalled();
    expect(endBackupOp).toHaveBeenCalledWith('A/R', 'backup-abc', null);
  });

  test('purged prefix → throws, nothing copied', async () => {
    const b = bucket([]);
    const { env } = envWith(b, { status: 'purged', archivedAt: null });
    const { step } = fakeStep();

    await expect(run(env, step)).rejects.toThrow('backup no longer eligible');
    expect(b.list).not.toHaveBeenCalled();
  });

  test('unknown prefix (row gone) → throws', async () => {
    const { env } = envWith(bucket([]), null);
    const { step } = fakeStep();
    await expect(run(env, step)).rejects.toThrow('backup no longer eligible');
  });
});

describe('startBackup', () => {
  test('reserves the op then creates the instance with the deterministic id', async () => {
    const beginOp = vi.fn(async () => {});
    const create = vi.fn(async () => {});
    const env = {
      STORAGE: { getByName: () => ({ beginOp }) },
      BACKUP_WORKFLOW: { create },
    } as unknown as CloudflareBindings;
    const params = { prefix: 'a/r' };
    const id = await startBackup(env, params);
    const expected = workflowInstanceId('backup', 'a/r');
    expect(id).toBe(expected);
    expect(beginOp).toHaveBeenCalledWith('a/r', expected, 'backup');
    expect(create).toHaveBeenCalledWith({ id: expected, params });
  });
});
