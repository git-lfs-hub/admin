import { test, expect, vi, beforeEach, describe } from 'vitest';

const reconcileRepoEvent = vi.fn(async (..._a: unknown[]) => {});
vi.mock('@/reconcile/repos', () => ({
  reconcileRepoEvent: (...a: unknown[]) => reconcileRepoEvent(...a),
}));

import { handleInstallation, handleInstallationRepositories } from '@/webhooks/installation';

const upsertOrgStatus = vi.fn(async () => ({}));
const reposStub = { upsertOrgStatus };
const env = { REPOS: { getByName: () => reposStub } } as any;

beforeEach(() => {
  reconcileRepoEvent.mockClear();
  upsertOrgStatus.mockClear();
});

describe('handleInstallation', () => {
  test.each(['created', 'unsuspend'])('%s → org active', async (action) => {
    await handleInstallation(env, { action, installation: { account: { login: 'acme' } } });
    expect(upsertOrgStatus).toHaveBeenCalledWith('acme', 'active');
  });

  test.each(['deleted', 'suspend'])('%s → org no_installation', async (action) => {
    await handleInstallation(env, { action, installation: { account: { login: 'acme' } } });
    expect(upsertOrgStatus).toHaveBeenCalledWith('acme', 'no_installation');
  });

  test('unknown action → no-op', async () => {
    await handleInstallation(env, {
      action: 'new_permissions_accepted',
      installation: { account: { login: 'acme' } },
    });
    expect(upsertOrgStatus).not.toHaveBeenCalled();
  });
});

describe('handleInstallationRepositories', () => {
  test('removed → present=false per repo', async () => {
    await handleInstallationRepositories(env, {
      action: 'removed',
      repositories_removed: [{ full_name: 'acme/a' }, { full_name: 'acme/b' }],
    });
    expect(reconcileRepoEvent).toHaveBeenCalledWith(env, reposStub, 'acme', 'a', false);
    expect(reconcileRepoEvent).toHaveBeenCalledWith(env, reposStub, 'acme', 'b', false);
  });

  test('added → present=true per repo', async () => {
    await handleInstallationRepositories(env, {
      action: 'added',
      repositories_added: [{ full_name: 'acme/c' }],
    });
    expect(reconcileRepoEvent).toHaveBeenCalledWith(env, reposStub, 'acme', 'c', true);
  });

  test('missing arrays → no-op', async () => {
    await handleInstallationRepositories(env, { action: 'added' });
    expect(reconcileRepoEvent).not.toHaveBeenCalled();
  });
});
