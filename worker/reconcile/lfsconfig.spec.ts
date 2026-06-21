import { test, expect, vi, beforeEach, describe } from 'vitest';

const scanLfsConfigInline = vi.fn(async (..._a: unknown[]) => 'ok');
vi.mock('@/github/lfsconfig', () => ({
  scanLfsConfigInline: (...a: unknown[]) => scanLfsConfigInline(...a),
}));

const syncLinks = vi.fn(async () => {});
const byRepo = vi.fn((..._a: unknown[]) => ({ syncLinks }));
vi.mock('@/db/repo', () => ({ Repo: { byRepo: (...a: unknown[]) => byRepo(...a) } }));

import { syncLfsconfigs } from '@/reconcile/lfsconfig';

const env = {} as any;
const scan = (over: Record<string, unknown> = {}) => ({
  owner: 'Acme',
  name: 'repo',
  branch: 'main',
  headSha: 'h1',
  lfsconfig: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  scanLfsConfigInline.mockResolvedValue('ok');
});

describe('syncLfsconfigs', () => {
  test('records the inline blob and syncs links on a changed scan', async () => {
    const blob = { oid: 'b1', text: '[lfs]' };
    await syncLfsconfigs(env, [scan({ lfsconfig: blob })]);
    expect(scanLfsConfigInline).toHaveBeenCalledWith(
      { syncLinks },
      env,
      { owner: 'Acme', repo: 'repo', branch: 'main', headSha: 'h1' },
      blob,
    );
    expect(syncLinks).toHaveBeenCalledWith('Acme', 'repo');
  });

  test('missing .lfsconfig still syncs links (stales dropped prefixes)', async () => {
    scanLfsConfigInline.mockResolvedValue('missing');
    await syncLfsconfigs(env, [scan()]);
    expect(syncLinks).toHaveBeenCalledWith('Acme', 'repo');
  });

  test('unchanged head → no syncLinks (links already current)', async () => {
    scanLfsConfigInline.mockResolvedValue('unchanged');
    await syncLfsconfigs(env, [scan()]);
    expect(syncLinks).not.toHaveBeenCalled();
  });

  test('unreachable blob → no syncLinks (prior links left intact)', async () => {
    scanLfsConfigInline.mockResolvedValue('unreachable');
    await syncLfsconfigs(env, [scan({ lfsconfig: { oid: 'b1', text: null } })]);
    expect(syncLinks).not.toHaveBeenCalled();
  });

  test('empty repo (no default branch) → skipped, no scan', async () => {
    await syncLfsconfigs(env, [scan({ branch: null, headSha: null })]);
    expect(byRepo).not.toHaveBeenCalled();
    expect(scanLfsConfigInline).not.toHaveBeenCalled();
  });

  test('a per-repo failure is isolated; later repos still scan', async () => {
    scanLfsConfigInline.mockRejectedValueOnce(new Error('boom'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await syncLfsconfigs(env, [scan({ name: 'bad' }), scan({ name: 'good' })]);
    expect(scanLfsConfigInline).toHaveBeenCalledTimes(2);
    expect(syncLinks).toHaveBeenCalledWith('Acme', 'good');
    err.mockRestore();
  });
});
