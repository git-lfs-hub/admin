import { Hono } from 'hono';
import { test, expect, vi, beforeEach, describe } from 'vitest';

const reconcileAll = vi.fn(async (..._a: unknown[]) => {});
const handleObjectEvents = vi.fn(async (..._a: unknown[]) => {});

vi.mock('@/reconcile/index', () => ({ reconcileAll: (...a: unknown[]) => reconcileAll(...a) }));
vi.mock('@/server/object-events', () => ({
  handleObjectEvents: (...a: unknown[]) => handleObjectEvents(...a),
}));
vi.mock('@/db/registry', () => ({ Registry: class {} }));
vi.mock('@/db/storage', () => ({ Storage: class {} }));
// Route/middleware modules pull heavy deps; stub them — index wiring is what we test.
vi.mock('@/middleware/auth', () => ({
  default: async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('@/api/me', () => ({ default: new Hono() }));
vi.mock('@/api/repos', () => ({ default: new Hono() }));
vi.mock('@/login/oauth', () => ({ default: new Hono() }));
vi.mock('@/webhooks/index', () => ({ default: new Hono() }));

import worker from '@/index';

const registryStub = { id: 'registry' };

function makeEnv() {
  return {
    REGISTRY: { getByName: vi.fn(() => registryStub) },
    LFS_BUCKET: { bucket: true },
    ASSETS: { fetch: vi.fn(async () => new Response('asset')) },
  } as any;
}

beforeEach(() => {
  reconcileAll.mockClear();
  handleObjectEvents.mockClear();
});

describe('scheduled', () => {
  test('delegates the cron pipeline to reconcileAll', async () => {
    const env = makeEnv();
    const ctx = { waitUntil: vi.fn() } as any;
    await worker.scheduled!({} as any, env, ctx);
    await ctx.waitUntil.mock.calls[0][0];
    expect(reconcileAll).toHaveBeenCalledWith(env);
  });
});

describe('queue', () => {
  test('delegates the batch to handleObjectEvents', async () => {
    const env = makeEnv();
    const batch = { messages: [] } as any;
    await worker.queue!(batch, env);
    expect(handleObjectEvents).toHaveBeenCalledWith(batch, env);
  });
});

describe('dev reconcile middleware', () => {
  const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any;

  test('non-local host does not fire reconcile', async () => {
    const env = makeEnv();
    await worker.fetch!(new Request('https://example.com/api/me'), env, ctx);
    expect(reconcileAll).not.toHaveBeenCalled();
  });

  test('localhost fires reconcile exactly once across requests', async () => {
    const env = makeEnv();
    await worker.fetch!(new Request('http://localhost/api/me'), env, ctx);
    await worker.fetch!(new Request('http://localhost/api/me'), env, ctx);
    expect(reconcileAll).toHaveBeenCalledTimes(1);
    expect(reconcileAll).toHaveBeenCalledWith(env, true);
  });
});
