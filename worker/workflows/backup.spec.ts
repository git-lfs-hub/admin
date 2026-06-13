import type { WorkflowStep } from 'cloudflare:workers';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { BackupWorkflow, startBackup } from '@/workflows/backup';

// copyObject + the stores are covered by their own units (s3/copy.spec, s3/backup.spec) — stub them
// so the test drives the workflow's own logic: the start-capture of `archivedAt`, the R2 cursor-walk,
// and the finish handoff. The s3Store stub encodes its storage class so the assertion can check it.
const copyObject = vi.fn(async (..._a: unknown[]) => {});
vi.mock('@/s3/copy', () => ({
  copyObject: (key: unknown, src: unknown, dst: unknown) => copyObject(key, src, dst),
}));
vi.mock('@/s3/r2-store', () => ({ r2Store: () => 'R2' }));
vi.mock('@/s3/s3-store', () => ({ s3Store: (_env: unknown, cls: unknown) => `S3:${cls}` }));

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
    expect(copyObject).toHaveBeenCalledWith('A/R/o1', 'R2', 'S3:GLACIER_IR');
    expect(copyObject).toHaveBeenCalledWith('A/R/o2', 'R2', 'S3:GLACIER_IR');
    expect(endBackupOp).toHaveBeenCalledWith('A/R', 'backup-abc', blocked.archivedAt);
    expect(calls).toEqual(['begin', 'copy:0', 'finish']);
  });

  test('walks the cursor across pages until exhausted', async () => {
    const b = bucket([{ keys: ['A/R/o1'], cursor: 'c1' }, { keys: ['A/R/o2'] }]);
    const { env } = envWith(b, blocked);
    const { step, calls } = fakeStep();

    await run(env, step);

    expect(b.list).toHaveBeenNthCalledWith(2, { prefix: 'A/R/', cursor: 'c1' });
    expect(copyObject).toHaveBeenCalledTimes(2);
    expect(calls).toContain('copy:1');
  });

  test('started unblocked → finishes with archivedAt null (incomplete copy)', async () => {
    const b = bucket([{ keys: [] }]);
    const { env, endBackupOp } = envWith(b, { status: 'used', archivedAt: null });
    const { step } = fakeStep();

    await run(env, step);

    expect(copyObject).not.toHaveBeenCalled();
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
  test('reserves the op then creates the instance with a fresh id', async () => {
    const beginOp = vi.fn(async () => {});
    const create = vi.fn(async () => {});
    const env = {
      STORAGE: { getByName: () => ({ beginOp }) },
      BACKUP_WORKFLOW: { create },
    } as unknown as CloudflareBindings;
    const params = { prefix: 'a/r' };
    const id = await startBackup(env, params);
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
      BACKUP_WORKFLOW: { create },
    } as unknown as CloudflareBindings;
    const params = { prefix: 'a/r' };
    const first = await startBackup(env, params);
    const second = await startBackup(env, params);
    expect(second).not.toBe(first);
  });
});
