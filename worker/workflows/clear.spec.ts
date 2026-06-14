import type { WorkflowStep } from 'cloudflare:workers';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { ClearWorkflow } from '@/workflows/clear';
import { runConfirmation } from '@/workflows/confirm';

// Gate is covered by confirm.spec — stub it so these drive ClearWorkflow.run's own logic: the
// eligibility re-read, the start-of-run `markCleared`, the R2 cursor-walk delete loop, and the
// finish handoff (status untouched).
vi.mock('@/workflows/confirm', () => ({ runConfirmation: vi.fn(async () => {}) }));

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
      STORAGE: { getByName: () => ({ endClearOp, endOp: vi.fn(async () => {}) }) },
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
    expect(calls).toEqual(['begin', 'mark', 'r2-delete:0', 'finish']);
  });

  test('inline (no triggeredBy) → skips the confirmation gate', async () => {
    const { env } = envWith(bucket([{ keys: [] }]), eligible);
    await run(env, fakeStep().step);
    expect(runConfirmation).not.toHaveBeenCalled();
  });

  test('auto path → runs the wait-only gate (kind clear) before begin', async () => {
    const autoEvent = {
      payload: { prefix: 'A/R', triggeredBy: 'auto', scope: 'storage:a/r' },
      instanceId: 'clear-abc123',
    };
    const { env } = envWith(bucket([{ keys: [] }]), eligible);
    const { step, calls } = fakeStep();

    await new ClearWorkflow({} as never, env).run(autoEvent as never, step);

    expect(runConfirmation).toHaveBeenCalledWith(
      step,
      expect.objectContaining({ kind: 'clear', scope: 'storage:a/r', triggeredBy: 'auto' }),
    );
    expect(calls).toEqual(['begin', 'mark', 'r2-delete:0', 'finish']); // gate steps are stubbed
  });

  test('walks the cursor across pages until exhausted', async () => {
    const b = bucket([{ keys: ['A/R/o1'], cursor: 'c1' }, { keys: ['A/R/o2'] }]);
    const { env } = envWith(b, eligible);
    const { step, calls } = fakeStep();

    await run(env, step);

    expect(b.list).toHaveBeenNthCalledWith(2, { prefix: 'A/R/', cursor: 'c1' });
    expect(b.delete).toHaveBeenCalledTimes(2);
    expect(calls).toContain('r2-delete:1');
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
