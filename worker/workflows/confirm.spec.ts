import type { WorkflowStep } from 'cloudflare:workers';
import { describe, expect, test, vi } from 'vitest';

import type { ConfirmKind } from '@/db/alerts-schema';
import {
  ConfirmAborted,
  readConfirmGate,
  runConfirmation,
  wakeConfirmation,
  type ConfirmCtx,
} from '@/workflows/confirm';

// waitForEvent resolves when an event fires, rejects (TimeoutError) when the deadline elapses.
const fire = async () => {};
const deadline = async () => {
  const e = new Error('event timed out');
  e.name = 'TimeoutError';
  throw e;
};

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
  triggeredBy: 'admin',
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
  function fakeStep(gateOutcomes: string[], waits: Array<() => Promise<void>>) {
    let gi = 0;
    let wi = 0;
    const sendConfirmation = vi.fn(async () => ({}));
    return {
      sendConfirmation,
      step: {
        do: async (name: string, cb: () => Promise<unknown>) =>
          name.endsWith(':gate') ? gateOutcomes[gi++] : cb(),
        waitForEvent: async () => waits[wi++](),
      } as unknown as WorkflowStep,
      env: { ALERTS: { getByName: () => ({ sendConfirmation }) } } as unknown as CloudflareBindings,
    };
  }

  test('delivers once, then proceeds on approve', async () => {
    const { step, env, sendConfirmation } = fakeStep(['proceed'], [fire]);
    await runConfirmation(step, ctx(env));
    expect(sendConfirmation).toHaveBeenCalledWith({ kind: 'purge', scope: 'storage:a/r' });
  });

  test('terminate → throws ConfirmAborted', async () => {
    const { step, env } = fakeStep(['terminate'], [fire]);
    await expect(runConfirmation(step, ctx(env))).rejects.toBeInstanceOf(ConfirmAborted);
  });

  test('admin path: undecided at deadline → proceeds (timeout)', async () => {
    const { step, env } = fakeStep(['wait'], [deadline]);
    await expect(
      runConfirmation(step, ctx(env, { triggeredBy: 'admin' })),
    ).resolves.toBeUndefined();
  });

  test('cron path: undecided at deadline → loops (never auto-proceeds), proceeds on later approve', async () => {
    const { step, env } = fakeStep(['wait', 'proceed'], [deadline, fire]);
    await expect(runConfirmation(step, ctx(env, { triggeredBy: 'auto' }))).resolves.toBeUndefined();
  });

  test('a non-timeout waitForEvent error propagates', async () => {
    const { step, env } = fakeStep(
      ['proceed'],
      [
        async () => {
          throw new Error('boom');
        },
      ],
    );
    await expect(runConfirmation(step, ctx(env))).rejects.toThrow('boom');
  });
});

describe('wakeConfirmation', () => {
  function wakeEnv(kind: ConfirmKind, prefix: string | null, sendEvent = vi.fn(async () => {})) {
    const binding = kind === 'purge' ? 'PURGE_WORKFLOW' : 'CLEAR_WORKFLOW';
    return {
      env: {
        REGISTRY: {
          getByName: () => ({ getStorageByPrefix: async () => (prefix ? { prefix } : null) }),
        },
        STORAGE: { getByName: () => ({ activeInstanceId: async () => `${kind}-abc123` }) },
        [binding]: { get: async () => ({ sendEvent }) },
      } as unknown as CloudflareBindings,
      sendEvent,
    };
  }

  test.each(['purge', 'clear'] as ConfirmKind[])(
    '%s: maps scope → prefix and sends alert_%s to the instance',
    async (kind) => {
      const { env: e, sendEvent } = wakeEnv(kind, 'Alice/Repo');
      await wakeConfirmation(e, 'storage:alice/repo', kind, 'approve', 'slack:u');
      expect(sendEvent).toHaveBeenCalledWith({
        type: `alert_${kind}`,
        payload: { decision: 'approve', by: 'slack:u' },
      });
    },
  );

  test('no matching storage row → no-op', async () => {
    const { env: e, sendEvent } = wakeEnv('purge', null);
    await wakeConfirmation(e, 'storage:alice/repo', 'purge', 'cancel', 'slack:u');
    expect(sendEvent).not.toHaveBeenCalled();
  });

  test('gone instance (get throws) is swallowed', async () => {
    const e = {
      REGISTRY: { getByName: () => ({ getStorageByPrefix: async () => ({ prefix: 'a/r' }) }) },
      STORAGE: { getByName: () => ({ activeInstanceId: async () => 'purge-abc123' }) },
      PURGE_WORKFLOW: {
        get: async () => {
          throw new Error('not found');
        },
      },
    } as unknown as CloudflareBindings;
    await expect(
      wakeConfirmation(e, 'storage:a/r', 'purge', 'approve', 'u'),
    ).resolves.toBeUndefined();
  });
});
