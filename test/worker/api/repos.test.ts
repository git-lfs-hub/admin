import { reset } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { describe, test, expect, afterEach } from 'vitest';

import reposApp from '@/api/repos';

afterEach(async () => {
  await reset();
});

const reg = () => env.REGISTRY.getByName('global');

// Drive the sub-app directly: the full localhost fetch fires the dev reconcile, which seeds
// git `repos` from the fixture. A fabricated env (real REGISTRY/STORAGE) isolates the data.
const appEnv = () =>
  ({ REGISTRY: env.REGISTRY, STORAGE: env.STORAGE, GC: env.GC }) as unknown as CloudflareBindings;
const get = () => reposApp.request('/', {}, appEnv());

describe('GET /api/repos', () => {
  test('returns empty array when no repos exist', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ repos: [] });
  });

  test('returns git presence rows with status', async () => {
    await reg().upsertRepo('alice', 'live');
    await reg().upsertRepo('bob', 'gone');
    await reg().markMissing('bob', 'gone');

    const res = await get();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      repos: Array<{ owner: string; repo: string; status: string; missingAt: string | null }>;
    };
    const byRepo = Object.fromEntries(body.repos.map((r) => [r.repo, r]));
    expect(byRepo.live.status).toBe('active');
    expect(byRepo.live.missingAt).toBeNull();
    expect(byRepo.gone.status).toBe('missing');
    expect(byRepo.gone.missingAt).toBeTruthy();
  });

  test('cross-links consumed prefixes from links; empty when unlinked', async () => {
    await reg().upsertRepo('alice', 'a');
    await reg().upsertStorage('alice/a');
    await reg().upsertStorage('alice/a-mirror');
    await reg().syncLinks('alice', 'a', new Set(['alice/a', 'alice/a-mirror']));
    await reg().upsertRepo('bob', 'nostore');

    const res = await get();
    const body = (await res.json()) as {
      repos: Array<{ repo: string; storage: Array<{ prefix: string; status: string }> }>;
    };
    const byRepo = Object.fromEntries(body.repos.map((r) => [r.repo, r]));
    expect(byRepo.a.storage).toEqual([
      { prefix: 'alice/a', status: 'pending', archivedAt: null },
      { prefix: 'alice/a-mirror', status: 'pending', archivedAt: null },
    ]);
    expect(byRepo.nostore.storage).toEqual([]);
  });

  test('returns 401 without session on production host', async () => {
    const res = await exports.default.fetch('http://admin.example.com/api/repos');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthenticated' });
  });
});
