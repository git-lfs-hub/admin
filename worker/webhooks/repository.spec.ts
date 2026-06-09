import { test, expect, vi, beforeEach, describe } from 'vitest';

const reconcileRepoEvent = vi.fn(async (..._a: unknown[]) => {});
vi.mock('@/reconcile/repos', () => ({
  reconcileRepoEvent: (...a: unknown[]) => reconcileRepoEvent(...a),
}));

import { handleRepository } from '@/webhooks/repository';

const registryStub = { id: 'registry' };
const env = { REGISTRY: { getByName: () => registryStub } } as any;

function repoEvent(action: string, extra: Record<string, unknown> = {}) {
  return {
    action,
    repository: { name: 'foo', full_name: 'acme/foo', owner: { login: 'acme' } },
    ...extra,
  } as any;
}

beforeEach(() => reconcileRepoEvent.mockClear());

describe('handleRepository', () => {
  test.each(['deleted', 'privatized', 'archived'])('%s → present=false', async (action) => {
    await handleRepository(env, repoEvent(action));
    expect(reconcileRepoEvent).toHaveBeenCalledWith(env, registryStub, 'acme', 'foo', false);
  });

  test.each(['created', 'publicized', 'unarchived'])('%s → present=true', async (action) => {
    await handleRepository(env, repoEvent(action));
    expect(reconcileRepoEvent).toHaveBeenCalledWith(env, registryStub, 'acme', 'foo', true);
  });

  test('unknown action → no-op', async () => {
    await handleRepository(env, repoEvent('edited'));
    expect(reconcileRepoEvent).not.toHaveBeenCalled();
  });

  test('renamed → old name missing + new name present (same owner)', async () => {
    await handleRepository(
      env,
      repoEvent('renamed', { changes: { repository: { name: { from: 'old' } } } }),
    );
    expect(reconcileRepoEvent).toHaveBeenCalledWith(env, registryStub, 'acme', 'old', false);
    expect(reconcileRepoEvent).toHaveBeenCalledWith(env, registryStub, 'acme', 'foo', true);
  });

  test('renamed without a known old name → still marks the new name present', async () => {
    await handleRepository(env, repoEvent('renamed'));
    expect(reconcileRepoEvent).toHaveBeenCalledTimes(1);
    expect(reconcileRepoEvent).toHaveBeenCalledWith(env, registryStub, 'acme', 'foo', true);
  });

  test('transferred (from org) → old owner missing + new owner/repo present', async () => {
    await handleRepository(
      env,
      repoEvent('transferred', {
        changes: { owner: { from: { organization: { login: 'oldorg' } } } },
      }),
    );
    expect(reconcileRepoEvent).toHaveBeenCalledWith(env, registryStub, 'oldorg', 'foo', false);
    expect(reconcileRepoEvent).toHaveBeenCalledWith(env, registryStub, 'acme', 'foo', true);
  });

  test('transferred (from user) → old user owner missing', async () => {
    await handleRepository(
      env,
      repoEvent('transferred', {
        changes: { owner: { from: { user: { login: 'olduser' } } } },
      }),
    );
    expect(reconcileRepoEvent).toHaveBeenCalledWith(env, registryStub, 'olduser', 'foo', false);
  });

  test('transferred without a known old owner → still marks the new location present', async () => {
    await handleRepository(env, repoEvent('transferred'));
    expect(reconcileRepoEvent).toHaveBeenCalledTimes(1);
    expect(reconcileRepoEvent).toHaveBeenCalledWith(env, registryStub, 'acme', 'foo', true);
  });
});
