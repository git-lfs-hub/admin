import type { WorkflowStep } from 'cloudflare:workers';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { ClearWorkflow, startClear } from '@/workflows/clear';
import { workflowInstanceId } from '@/workflows/instanceId';

// Drives ClearWorkflow.run's own logic: the eligibility re-read, the start-of-run `markCleared`,
// the R2 cursor-walk delete loop, and the finish handoff (status untouched).

const event = { payload: { prefix: 'A/R' }, instanceId: 'clear-abc123' };

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
  hooks: { markCleared?: ReturnType<typeof vi.fn>; endClearOp?: ReturnType<typeof vi.fn> } = {},
) {
  const markCleared = hooks.markCleared ?? vi.fn(async () => {});
  const endClearOp = hooks.endClearOp ?? vi.fn(async () => {});
  return {
    env: {
      LFS_BUCKET: b,
      REGISTRY: { getByName: () => ({ getStorage: vi.fn(async () => storageRow), markCleared }) },
      STORAGE: { getByName: () => ({ endClearOp }) },
    } as unknown as CloudflareBindings,
    markCleared,
    endClearOp,
  };
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
  new ClearWorkflow({} as never, env).run(event as never, step);

const eligible = {
  status: 'unused',
  archivedAt: '2026-01-01T00:00:00Z',
  backupComplete: true,
  clearedAt: null,
};

describe('ClearWorkflow.run', () => {
  beforeEach(() => vi.clearAllMocks());

  test('eligible → marks cleared, deletes one page, ends clear op (in order)', async () => {
    const b = bucket([{ keys: ['A/R/o1', 'A/R/o2'] }]);
    const { env, markCleared, endClearOp } = envWith(b, eligible);
    const { step, calls } = fakeStep();

    await run(env, step);

    expect(markCleared).toHaveBeenCalledWith('A/R');
    expect(b.list).toHaveBeenCalledWith({ prefix: 'A/R/' });
    expect(b.delete).toHaveBeenCalledWith(['A/R/o1', 'A/R/o2']);
    expect(endClearOp).toHaveBeenCalledWith('A/R', 'clear-abc123');
    // `mark` (stamp clearedAt) runs BEFORE any delete.
    expect(calls).toEqual(['begin', 'mark', 'delete:0', 'finish']);
  });

  test('walks the cursor across pages until exhausted', async () => {
    const b = bucket([{ keys: ['A/R/o1'], cursor: 'c1' }, { keys: ['A/R/o2'] }]);
    const { env } = envWith(b, eligible);
    const { step, calls } = fakeStep();

    await run(env, step);

    expect(b.list).toHaveBeenNthCalledWith(2, { prefix: 'A/R/', cursor: 'c1' });
    expect(b.delete).toHaveBeenCalledTimes(2);
    expect(calls).toContain('delete:1');
  });

  test('empty bucket → no delete, still marks cleared + ends op', async () => {
    const b = bucket([{ keys: [] }]);
    const { env, markCleared, endClearOp } = envWith(b, eligible);
    const { step } = fakeStep();

    await run(env, step);

    expect(markCleared).toHaveBeenCalledWith('A/R');
    expect(b.delete).not.toHaveBeenCalled();
    expect(endClearOp).toHaveBeenCalledWith('A/R', 'clear-abc123');
  });

  test.each([
    ['row gone', null],
    ['purged', { ...eligible, status: 'purged' }],
    ['not blocked', { ...eligible, archivedAt: null }],
    ['backup incomplete', { ...eligible, backupComplete: false }],
    ['already cleared', { ...eligible, clearedAt: '2026-02-01T00:00:00Z' }],
  ])('ineligible (%s) → throws, nothing marked or deleted', async (_label, row) => {
    const b = bucket([]);
    const { env, markCleared } = envWith(b, row);
    const { step } = fakeStep();

    await expect(run(env, step)).rejects.toThrow('clear no longer eligible');
    expect(markCleared).not.toHaveBeenCalled();
    expect(b.list).not.toHaveBeenCalled();
  });
});

describe('startClear', () => {
  test('reserves the op then creates the instance with the deterministic id', async () => {
    const beginOp = vi.fn(async () => {});
    const create = vi.fn(async () => {});
    const env = {
      STORAGE: { getByName: () => ({ beginOp }) },
      CLEAR_WORKFLOW: { create },
    } as unknown as CloudflareBindings;
    const params = { prefix: 'a/r' };
    const id = await startClear(env, params);
    const expected = workflowInstanceId('clear', 'a/r');
    expect(id).toBe(expected);
    expect(beginOp).toHaveBeenCalledWith('a/r', expected, 'clear');
    expect(create).toHaveBeenCalledWith({ id: expected, params });
  });
});
