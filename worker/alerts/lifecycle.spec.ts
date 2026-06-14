import { describe, expect, test, vi } from 'vitest';

import { notify } from '@/alerts/lifecycle';

function fakeEnv() {
  const sendNotification = vi.fn(async () => ({}));
  const clearAlert = vi.fn(async () => {});
  const getByName = vi.fn(() => ({ sendNotification, clearAlert }));
  return { env: { ALERTS: { getByName } } as any, sendNotification, clearAlert, getByName };
}

describe('notify', () => {
  test('sends the kind (lowercased scope) and clears the states it supersedes', async () => {
    const { env, sendNotification, clearAlert, getByName } = fakeEnv();
    await notify(env, 'Alice', 'My-Repo', 'missing');
    expect(getByName).toHaveBeenCalledWith('global');
    expect(clearAlert).toHaveBeenCalledWith('storage:alice/my-repo', 'reappeared');
    expect(clearAlert).toHaveBeenCalledWith('storage:alice/my-repo', 'restored');
    expect(sendNotification).toHaveBeenCalledWith({
      kind: 'missing',
      scope: 'storage:alice/my-repo',
    });
  });

  test('archiving supersedes the unused/missing alert', async () => {
    const { env, clearAlert } = fakeEnv();
    await notify(env, 'o', 'r', 'archived');
    expect(clearAlert).toHaveBeenCalledWith('storage:o/r', 'missing');
    expect(clearAlert).toHaveBeenCalledWith('storage:o/r', 'restored');
  });

  test('restore clears archived', async () => {
    const { env, clearAlert } = fakeEnv();
    await notify(env, 'o', 'r', 'restored');
    expect(clearAlert).toHaveBeenCalledWith('storage:o/r', 'archived');
  });

  test('best-effort: a failing DO is swallowed, never thrown', async () => {
    const env = {
      ALERTS: {
        getByName: () => {
          throw new Error('do down');
        },
      },
    } as any;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(notify(env, 'o', 'r', 'missing')).resolves.toBeUndefined();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});
