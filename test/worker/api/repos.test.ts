import { reset } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { describe, test, expect, afterEach, vi } from 'vitest';

import reposApp from '@/api/repos';

afterEach(async () => {
  await reset();
});

const reg = () => env.REGISTRY.getByName('global');

// The LFS_SERVER service binding is stripped from the test wrangler (services: null),
// so drive the sub-app directly with a fabricated env: the real REGISTRY/STORAGE/GC
// bindings plus a stub lfs-server we can assert on / make fail.
function appEnv(lfs: Partial<Record<'blockRepo' | 'unblockRepo' | 'purgeRepo', unknown>> = {}) {
  const LFS_SERVER = {
    blockRepo: vi.fn(async () => {}),
    unblockRepo: vi.fn(async () => {}),
    purgeRepo: vi.fn(async () => {}),
    ...lfs,
  };
  return {
    env: {
      REGISTRY: env.REGISTRY,
      STORAGE: env.STORAGE,
      GC: env.GC,
      LFS_SERVER,
    } as unknown as CloudflareBindings,
    blockRepo: LFS_SERVER.blockRepo,
    unblockRepo: LFS_SERVER.unblockRepo,
  };
}
const post = (path: string, e: CloudflareBindings) => reposApp.request(path, { method: 'POST' }, e);

type Usage = Record<string, { count: number; size: number }>;

// Seed a storage prefix in the `unused` resting state (archivable).
async function seedUnused(prefix: string) {
  await reg().upsertStorage(prefix);
  await reg().markUnused(prefix);
}

describe('GET /api/repos', () => {
  test('returns empty array when no storage prefixes exist (localhost bypass)', async () => {
    const res = await exports.default.fetch('http://localhost/api/repos');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ repos: [] });
  });

  test('returns all prefixes across statuses with zero object stats when empty', async () => {
    await reg().upsertStorage('alice/a');
    await seedUnused('bob/b');

    const res = await exports.default.fetch('http://localhost/api/repos');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      repos: Array<{
        repo: string;
        status: string;
        usage: Usage;
        willPurgeAt: string | null;
        lastAccessedAt: string | null;
      }>;
    };

    expect(body.repos).toHaveLength(2);
    const byRepo = Object.fromEntries(body.repos.map((r) => [r.repo, r]));
    expect(byRepo.a.status).toBe('used');
    expect(byRepo.b.status).toBe('unused');
    for (const r of body.repos) {
      expect(r.usage.present).toEqual({ count: 0, size: 0 });
      expect(r.willPurgeAt).toBeNull();
      expect(r.lastAccessedAt).toBeNull();
    }
  });

  test('returns lastAccessedAt from the index', async () => {
    await reg().upsertStorage('alice/a');
    const row = await env.STORAGE.getByName('alice/a').recordObject('oid', 10, 'download');

    const res = await exports.default.fetch('http://localhost/api/repos');
    const body = (await res.json()) as {
      repos: Array<{ repo: string; lastAccessedAt: string | null }>;
    };
    expect(body.repos.find((r) => r.repo === 'a')!.lastAccessedAt).toBe(row.lastAccessed);
  });

  test('returns the index usage breakdown by status', async () => {
    await reg().upsertStorage('alice/a');
    await env.STORAGE.getByName('alice/a').recordObject('oid1', 10, 'download'); // present
    await env.STORAGE.getByName('alice/a').recordObject('oid2', 5, 'verify'); // present
    await env.STORAGE.getByName('alice/a').recordObject('oid3', 7, 'upload'); // pending
    await reg().upsertStorage('bob/other');
    await env.STORAGE.getByName('bob/other').recordObject('oid', 1, 'download');

    const res = await exports.default.fetch('http://localhost/api/repos');
    const body = (await res.json()) as { repos: Array<{ repo: string; usage: Usage }> };
    const row = body.repos.find((r) => r.repo === 'a')!;
    expect(row.usage.present).toEqual({ count: 2, size: 15 });
    expect(row.usage.pending).toEqual({ count: 1, size: 7 });
  });

  test('resolves the index DO by the prefix canonical case', async () => {
    // lfs-server keys storage by the client's case; the prefix keeps that casing.
    await reg().upsertStorage('Alice/Repo');
    await env.STORAGE.getByName('Alice/Repo').recordObject('oid1', 7, 'download');
    await env.STORAGE.getByName('Alice/Repo').recordObject('oid2', 3, 'download');

    const res = await exports.default.fetch('http://localhost/api/repos');
    const body = (await res.json()) as { repos: Array<{ name: string; usage: Usage }> };
    const row = body.repos.find((r) => r.name === 'Alice/Repo')!;
    expect(row.usage.present).toEqual({ count: 2, size: 10 });
  });

  test('willArchiveAt = unusedAt + GC_AUTO_ARCHIVE_DAYS for unused, not-yet-blocked rows', async () => {
    await reg().upsertStorage('alice/gone');
    const unused = await reg().markUnused('alice/gone');
    expect(unused?.unusedAt).toBeTruthy();

    const res = await exports.default.fetch('http://localhost/api/repos');
    const body = (await res.json()) as {
      repos: Array<{ repo: string; unusedAt: string | null; willArchiveAt: string | null }>;
    };
    const row = body.repos.find((r) => r.repo === 'gone')!;
    expect(row.unusedAt).toBe(unused!.unusedAt);

    const archiveDays = env.GC.autoArchiveDays;
    const expected = new Date(row.unusedAt!).getTime() + archiveDays * 24 * 60 * 60 * 1000;
    expect(new Date(row.willArchiveAt!).getTime()).toBe(expected);
  });

  test('willPurgeAt = archivedAt + GC_LIVE_STORAGE_RETENTION_DAYS (no cold storage) for blocked rows', async () => {
    await seedUnused('alice/gone');
    const archived = await reg().block('alice/gone');
    expect(archived?.archivedAt).toBeTruthy();

    const res = await exports.default.fetch('http://localhost/api/repos');
    const body = (await res.json()) as {
      repos: Array<{ repo: string; archivedAt: string | null; willPurgeAt: string | null }>;
    };
    const row = body.repos.find((r) => r.repo === 'gone')!;
    expect(row.archivedAt).toBe(archived!.archivedAt);

    const retentionDays = env.GC.liveStorageRetentionDays;
    const expected = new Date(row.archivedAt!).getTime() + retentionDays * 24 * 60 * 60 * 1000;
    expect(new Date(row.willPurgeAt!).getTime()).toBe(expected);
  });

  test('returns 401 without session on production host', async () => {
    const res = await exports.default.fetch('http://admin.example.com/api/repos');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthenticated' });
  });
});

describe('POST /api/repos/:owner/:repo/archive', () => {
  test('unused prefix → blockRepo + archivedAt set, status stays unused', async () => {
    await seedUnused('alice/gone');
    const { env: e, blockRepo } = appEnv();

    const res = await post('/alice/gone/archive', e);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { repo: { status: string; archivedAt: string | null } };
    expect(body.repo.status).toBe('unused'); // block doesn't change status
    expect(body.repo.archivedAt).toBeTruthy();
    expect(blockRepo).toHaveBeenCalledWith('alice', 'gone');
    const row = await reg().getStorage('alice/gone');
    expect(row?.status).toBe('unused');
    expect(row?.archivedAt).toBeTruthy();
  });

  test('used prefix → 409, no block', async () => {
    await reg().upsertStorage('alice/live');
    const { env: e, blockRepo } = appEnv();

    const res = await post('/alice/live/archive', e);
    expect(res.status).toBe(409);
    expect(blockRepo).not.toHaveBeenCalled();
    expect((await reg().getStorage('alice/live'))?.archivedAt).toBeNull();
  });

  test('already blocked → 409, no second block', async () => {
    await seedUnused('alice/gone');
    await reg().block('alice/gone');
    const { env: e, blockRepo } = appEnv();

    const res = await post('/alice/gone/archive', e);
    expect(res.status).toBe(409);
    expect(blockRepo).not.toHaveBeenCalled();
  });

  test('unknown prefix → 404', async () => {
    const { env: e } = appEnv();
    const res = await post('/nobody/nope/archive', e);
    expect(res.status).toBe(404);
  });

  test('blockRepo failure → 502, row stays unblocked (DO unchanged)', async () => {
    await seedUnused('alice/gone');
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { env: e } = appEnv({
      blockRepo: vi.fn(async () => {
        throw new Error('rpc down');
      }),
    });

    const res = await post('/alice/gone/archive', e);
    expect(res.status).toBe(502);
    const row = await reg().getStorage('alice/gone');
    expect(row?.status).toBe('unused');
    expect(row?.archivedAt).toBeNull();
    warn.mockRestore();
  });
});

describe('POST /api/repos/:owner/:repo/restore', () => {
  async function seedBlocked(prefix: string) {
    await seedUnused(prefix);
    await reg().block(prefix);
  }

  test('blocked prefix → unblockRepo + archivedAt cleared, status unchanged (unused)', async () => {
    await seedBlocked('alice/gone');
    const { env: e, unblockRepo } = appEnv();

    const res = await post('/alice/gone/restore', e);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { repo: { status: string; archivedAt: string | null } };
    expect(body.repo.status).toBe('unused'); // link state untouched by restore
    expect(body.repo.archivedAt).toBeNull();
    expect(unblockRepo).toHaveBeenCalledWith('alice', 'gone');
    const row = await reg().getStorage('alice/gone');
    expect(row?.status).toBe('unused');
    expect(row?.archivedAt).toBeNull();
  });

  test('not-blocked prefix → 409, no unblock', async () => {
    await reg().upsertStorage('alice/live');
    const { env: e, unblockRepo } = appEnv();

    const res = await post('/alice/live/restore', e);
    expect(res.status).toBe(409);
    expect(unblockRepo).not.toHaveBeenCalled();
  });

  test('unknown prefix → 404', async () => {
    const { env: e } = appEnv();
    expect((await post('/nobody/nope/restore', e)).status).toBe(404);
  });

  test('unblockRepo failure → 502, row stays blocked', async () => {
    await seedBlocked('alice/gone');
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { env: e } = appEnv({
      unblockRepo: vi.fn(async () => {
        throw new Error('rpc down');
      }),
    });

    const res = await post('/alice/gone/restore', e);
    expect(res.status).toBe(502);
    expect((await reg().getStorage('alice/gone'))?.archivedAt).toBeTruthy();
    warn.mockRestore();
  });
});

describe('not-yet-implemented mutations → 501', () => {
  test.each([
    ['POST', '/alice/r/backup'],
    ['DELETE', '/alice/r/backup'],
    ['POST', '/alice/r/clear'],
    ['POST', '/alice/r/purge'],
  ])('%s %s', async (method, path) => {
    const { env: e } = appEnv();
    const res = await reposApp.request(path, { method }, e);
    expect(res.status).toBe(501);
  });
});
