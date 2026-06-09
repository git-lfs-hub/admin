import { describe, expect, test, vi } from 'vitest';

import {
  ConfirmAborted,
  readConfirmGate,
  runConfirmation,
  type ConfirmCtx,
  type ConfirmStep,
} from '@/alerts/confirm';

function envWith(alert: unknown, storage: unknown) {
  return {
    ALERTS: { getByName: () => ({ getAlert: vi.fn(async () => alert) }) },
    REGISTRY: { getByName: () => ({ getStorage: vi.fn(async () => storage) }) },
  } as unknown as CloudflareBindings;
}

const ctx = (env: CloudflareBindings, over: Partial<ConfirmCtx> = {}): ConfirmCtx => ({
  env,
  scope: 'storage:a/r',
  prefix: 'A/R',
  kind: 'purge',
  proceedOnTimeout: true,
  timeout: '3 days',
  ...over,
});

const archived = { status: 'unused', archivedAt: '2026-01-01T00:00:00Z' };

describe('readConfirmGate', () => {
  test('no alert → terminate', async () => {
    expect(await readConfirmGate(ctx(envWith(null, archived)))).toBe('terminate');
  });

  test('cancelled (hold) → terminate even if eligible', async () => {
    expect(await readConfirmGate(ctx(envWith({ decision: 'cancel' }, archived)))).toBe('terminate');
  });

  test('storage gone / purged / no longer archived → terminate', async () => {
    expect(await readConfirmGate(ctx(envWith({ decision: 'approve' }, null)))).toBe('terminate');
    expect(
      await readConfirmGate(
        ctx(envWith({ decision: 'approve' }, { status: 'purged', archivedAt: 'x' })),
      ),
    ).toBe('terminate');
    expect(
      await readConfirmGate(
        ctx(envWith({ decision: 'approve' }, { status: 'unused', archivedAt: null })),
      ),
    ).toBe('terminate');
  });

  test('eligible + approved → proceed; eligible + undecided → wait', async () => {
    expect(await readConfirmGate(ctx(envWith({ decision: 'approve' }, archived)))).toBe('proceed');
    expect(await readConfirmGate(ctx(envWith({ decision: null }, archived)))).toBe('wait');
  });
});

describe('runConfirmation', () => {
  function fakeStep(gateOutcomes: string[], waits: { timedOut: boolean }[]) {
    let gi = 0;
    let wi = 0;
    const sendConfirmation = vi.fn(async () => ({}));
    return {
      sendConfirmation,
      step: {
        do: async (name: string, cb: () => Promise<unknown>) =>
          name.endsWith(':gate') ? gateOutcomes[gi++] : cb(),
        waitForEvent: async () => waits[wi++],
      } as ConfirmStep,
      env: { ALERTS: { getByName: () => ({ sendConfirmation }) } } as unknown as CloudflareBindings,
    };
  }

  test('delivers once, then proceeds on approve', async () => {
    const { step, env, sendConfirmation } = fakeStep(['proceed'], [{ timedOut: false }]);
    await runConfirmation(step, ctx(env));
    expect(sendConfirmation).toHaveBeenCalledWith({ kind: 'purge', scope: 'storage:a/r' });
  });

  test('terminate → throws ConfirmAborted', async () => {
    const { step, env } = fakeStep(['terminate'], [{ timedOut: false }]);
    await expect(runConfirmation(step, ctx(env))).rejects.toBeInstanceOf(ConfirmAborted);
  });

  test('admin path: undecided at deadline → proceeds (timeout)', async () => {
    const { step, env } = fakeStep(['wait'], [{ timedOut: true }]);
    await expect(
      runConfirmation(step, ctx(env, { proceedOnTimeout: true })),
    ).resolves.toBeUndefined();
  });

  test('cron path: undecided at deadline → loops (never auto-proceeds), proceeds on later approve', async () => {
    const { step, env } = fakeStep(['wait', 'proceed'], [{ timedOut: true }, { timedOut: false }]);
    await expect(
      runConfirmation(step, ctx(env, { proceedOnTimeout: false })),
    ).resolves.toBeUndefined();
  });
});
