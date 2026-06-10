import { reset } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { describe, test, expect, afterEach, vi } from 'vitest';

import storageApp from '@/api/storage';

afterEach(async () => {
  await reset();
});

const reg = () => env.REGISTRY.getByName('global');

// The LFS_SERVER service binding is stripped from the test wrangler (services: null),
// so drive the sub-app directly with a fabricated env: the real REGISTRY/STORAGE/GC
// bindings plus a stub lfs-server we can assert on / make fail.
function appEnv(
  lfs: Partial<Record<'blockRepo' | 'unblockRepo' | 'purgeRepo', unknown>> = {},
  gc: Record<string, unknown> = {},
) {
  const LFS_SERVER = {
    blockRepo: vi.fn(async () => {}),
    unblockRepo: vi.fn(async () => {}),
    purgeRepo: vi.fn(async () => {}),
    ...lfs,
  };
  // PURGE_WORKFLOW is omitted from the test wrangler (no workflow runtime in the pool); stub
  // create()/get() so the trigger path (beginOp on the real STORAGE DO + create) is exercisable.
  const PURGE_WORKFLOW = { create: vi.fn(async () => {}), get: vi.fn() };
  return {
    env: {
      REGISTRY: env.REGISTRY,
      STORAGE: env.STORAGE,
      ALERTS: env.ALERTS,
      ADMIN: env.ADMIN,
      SLACK_BOT_TOKEN: env.SLACK_BOT_TOKEN,
      GC: { ...env.GC, ...gc },
      LFS_SERVER,
      PURGE_WORKFLOW,
    } as unknown as CloudflareBindings & { PURGE_WORKFLOW: typeof PURGE_WORKFLOW },
    blockRepo: LFS_SERVER.blockRepo,
    unblockRepo: LFS_SERVER.unblockRepo,
    purgeRepo: LFS_SERVER.purgeRepo,
    PURGE_WORKFLOW,
  };
}
const post = (path: string, e: CloudflareBindings) =>
  storageApp.request(path, { method: 'POST' }, e);

type Usage = Record<string, { count: number; size: number }>;

// Seed a storage prefix in the `unused` resting state (archivable).
async function seedUnused(prefix: string) {
  await reg().upsertStorage(prefix);
  await reg().markUnused(prefix);
}

describe('GET /api/storage', () => {
  test('returns empty array when no storage prefixes exist (localhost bypass)', async () => {
    const res = await exports.default.fetch('http://localhost/api/storage');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ storage: [] });
  });

  test('returns all prefixes across statuses with zero object stats when empty', async () => {
    await reg().upsertStorage('alice/a');
    await seedUnused('bob/b');

    const res = await exports.default.fetch('http://localhost/api/storage');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      storage: Array<{
        repo: string;
        status: string;
        usage: Usage;
        willPurgeAt: string | null;
        lastAccessedAt: string | null;
      }>;
    };

    expect(body.storage).toHaveLength(2);
    const byRepo = Object.fromEntries(body.storage.map((r) => [r.repo, r]));
    expect(byRepo.a.status).toBe('used');
    expect(byRepo.b.status).toBe('unused');
    for (const r of body.storage) {
      expect(r.usage.present).toEqual({ count: 0, size: 0 });
      expect(r.willPurgeAt).toBeNull();
      expect(r.lastAccessedAt).toBeNull();
    }
  });

  test('cross-links the matching git repo (same-key), null when none', async () => {
    await reg().upsertStorage('alice/a');
    await reg().upsertRepo('alice', 'a'); // git repo present
    await reg().upsertStorage('bob/orphan'); // no matching repo

    const res = await exports.default.fetch('http://localhost/api/storage');
    const body = (await res.json()) as {
      storage: Array<{ repo: string; gitRepo: { status: string } | null }>;
    };
    const byRepo = Object.fromEntries(body.storage.map((r) => [r.repo, r]));
    expect(byRepo.a.gitRepo).toEqual({ owner: 'alice', repo: 'a', status: 'active' });
    expect(byRepo.orphan.gitRepo).toBeNull();
  });

  test('returns lastAccessedAt from the index', async () => {
    await reg().upsertStorage('alice/a');
    const row = await env.STORAGE.getByName('alice/a').recordObject('oid', 10, 'download');

    const res = await exports.default.fetch('http://localhost/api/storage');
    const body = (await res.json()) as {
      storage: Array<{ repo: string; lastAccessedAt: string | null }>;
    };
    expect(body.storage.find((r) => r.repo === 'a')!.lastAccessedAt).toBe(row.lastAccessed);
  });

  test('returns the index usage breakdown by status', async () => {
    await reg().upsertStorage('alice/a');
    await env.STORAGE.getByName('alice/a').recordObject('oid1', 10, 'download'); // present
    await env.STORAGE.getByName('alice/a').recordObject('oid2', 5, 'verify'); // present
    await env.STORAGE.getByName('alice/a').recordObject('oid3', 7, 'upload'); // pending
    await reg().upsertStorage('bob/other');
    await env.STORAGE.getByName('bob/other').recordObject('oid', 1, 'download');

    const res = await exports.default.fetch('http://localhost/api/storage');
    const body = (await res.json()) as { storage: Array<{ repo: string; usage: Usage }> };
    const row = body.storage.find((r) => r.repo === 'a')!;
    expect(row.usage.present).toEqual({ count: 2, size: 15 });
    expect(row.usage.pending).toEqual({ count: 1, size: 7 });
  });

  test('resolves the index DO by the prefix canonical case', async () => {
    // lfs-server keys storage by the client's case; the prefix keeps that casing.
    await reg().upsertStorage('Alice/Repo');
    await env.STORAGE.getByName('Alice/Repo').recordObject('oid1', 7, 'download');
    await env.STORAGE.getByName('Alice/Repo').recordObject('oid2', 3, 'download');

    const res = await exports.default.fetch('http://localhost/api/storage');
    const body = (await res.json()) as { storage: Array<{ name: string; usage: Usage }> };
    const row = body.storage.find((r) => r.name === 'Alice/Repo')!;
    expect(row.usage.present).toEqual({ count: 2, size: 10 });
  });

  test('willArchiveAt = unusedAt + GC_AUTO_ARCHIVE_DAYS for unused, not-yet-blocked rows', async () => {
    await reg().upsertStorage('alice/gone');
    const unused = await reg().markUnused('alice/gone');
    expect(unused?.unusedAt).toBeTruthy();

    const res = await exports.default.fetch('http://localhost/api/storage');
    const body = (await res.json()) as {
      storage: Array<{ repo: string; unusedAt: string | null; willArchiveAt: string | null }>;
    };
    const row = body.storage.find((r) => r.repo === 'gone')!;
    expect(row.unusedAt).toBe(unused!.unusedAt);

    const archiveDays = env.GC.autoArchiveDays;
    const expected = new Date(row.unusedAt!).getTime() + archiveDays * 24 * 60 * 60 * 1000;
    expect(new Date(row.willArchiveAt!).getTime()).toBe(expected);
  });

  test('willPurgeAt = archivedAt + GC_LIVE_STORAGE_RETENTION_DAYS (no cold storage) for blocked rows', async () => {
    await seedUnused('alice/gone');
    const archived = await reg().block('alice/gone');
    expect(archived?.archivedAt).toBeTruthy();

    const res = await exports.default.fetch('http://localhost/api/storage');
    const body = (await res.json()) as {
      storage: Array<{ repo: string; archivedAt: string | null; willPurgeAt: string | null }>;
    };
    const row = body.storage.find((r) => r.repo === 'gone')!;
    expect(row.archivedAt).toBe(archived!.archivedAt);

    const retentionDays = env.GC.liveStorageRetentionDays;
    const expected = new Date(row.archivedAt!).getTime() + retentionDays * 24 * 60 * 60 * 1000;
    expect(new Date(row.willPurgeAt!).getTime()).toBe(expected);
  });

  test('returns 401 without session on production host', async () => {
    const res = await exports.default.fetch('http://admin.example.com/api/storage');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthenticated' });
  });
});

describe('POST /api/storage/:owner/:repo/archive', () => {
  test('unused prefix → blockRepo + archivedAt set, status stays unused', async () => {
    await seedUnused('alice/gone');
    const { env: e, blockRepo } = appEnv();

    const res = await post('/alice/gone/archive', e);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { storage: { status: string; archivedAt: string | null } };
    expect(body.storage.status).toBe('unused'); // block doesn't change status
    expect(body.storage.archivedAt).toBeTruthy();
    expect(blockRepo).toHaveBeenCalledWith('alice', 'gone');
    const row = await reg().getStorage('alice/gone');
    expect(row?.status).toBe('unused');
    expect(row?.archivedAt).toBeTruthy();
    // emits an `archived` notification for the scope
    expect(
      await env.ALERTS.getByName('global').getAlert('storage:alice/gone', 'archived'),
    ).toMatchObject({
      kind: 'archived',
      scope: 'storage:alice/gone',
    });
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

describe('POST /api/storage/:owner/:repo/restore', () => {
  async function seedBlocked(prefix: string) {
    await seedUnused(prefix);
    await reg().block(prefix);
  }

  test('blocked prefix → unblockRepo + archivedAt cleared, status unchanged (unused)', async () => {
    await seedBlocked('alice/gone');
    const { env: e, unblockRepo } = appEnv();

    const res = await post('/alice/gone/restore', e);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { storage: { status: string; archivedAt: string | null } };
    expect(body.storage.status).toBe('unused'); // link state untouched by restore
    expect(body.storage.archivedAt).toBeNull();
    expect(unblockRepo).toHaveBeenCalledWith('alice', 'gone');
    const row = await reg().getStorage('alice/gone');
    expect(row?.status).toBe('unused');
    expect(row?.archivedAt).toBeNull();
    // emits a `restored` notification (and clears any prior `archived` one)
    expect(
      await env.ALERTS.getByName('global').getAlert('storage:alice/gone', 'restored'),
    ).toMatchObject({
      kind: 'restored',
    });
    expect(
      await env.ALERTS.getByName('global').getAlert('storage:alice/gone', 'archived'),
    ).toBeNull();
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

describe('cold-storage ops → 501 (not yet implemented)', () => {
  test.each([
    ['POST', '/alice/r/backup'],
    ['DELETE', '/alice/r/backup'],
    ['POST', '/alice/r/clear'],
  ])('%s %s', async (method, path) => {
    const { env: e } = appEnv();
    const res = await storageApp.request(path, { method }, e);
    expect(res.status).toBe(501);
  });
});

// Seed an archived (blocked), unused prefix — the purgeable resting state.
async function seedArchived(prefix: string) {
  await seedUnused(prefix);
  await reg().block(prefix);
}

const purge = (path: string, e: CloudflareBindings, body?: unknown) =>
  storageApp.request(
    path,
    {
      method: 'POST',
      body: JSON.stringify(body ?? {}),
      headers: { 'content-type': 'application/json' },
    },
    e,
  );

describe('POST /api/storage/:o/:r/purge (no-cold path)', () => {
  test('preview on an archived prefix returns impact + a confirm token', async () => {
    await seedArchived('alice/r');
    await env.STORAGE.getByName('alice/r').recordObject('oid1', 10, 'verify');
    const { env: e } = appEnv();
    const res = await storageApp.request('/alice/r/purge/preview', { method: 'POST' }, e);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { confirmToken: string; impact: { objects: number } };
    expect(body.confirmToken).toMatch(/^[0-9a-f]{64}$/);
    expect(body.impact.objects).toBe(1);
  });

  test('preview/POST 409 when the prefix is not blocked', async () => {
    await seedUnused('alice/r');
    const { env: e } = appEnv();
    expect((await storageApp.request('/alice/r/purge/preview', { method: 'POST' }, e)).status).toBe(
      409,
    );
    expect((await purge('/alice/r/purge', e, { confirmToken: 'x' })).status).toBe(409);
  });

  test('409 in_use when a matching git repo is active', async () => {
    await seedArchived('alice/r');
    await reg().upsertRepo('alice', 'r'); // active git repo → prefix in use
    const { env: e } = appEnv();
    const res = await storageApp.request('/alice/r/purge/preview', { method: 'POST' }, e);
    expect(await res.json()).toMatchObject({ error: 'in_use' });
    expect(res.status).toBe(409);
  });

  test('stale/missing token → 409', async () => {
    await seedArchived('alice/r');
    const { env: e } = appEnv();
    expect((await purge('/alice/r/purge', e, { confirmToken: 'nope' })).status).toBe(409);
  });

  test('valid token → starts the workflow (beginOp reserved + create called) → 202', async () => {
    await seedArchived('alice/r');
    const { env: e, PURGE_WORKFLOW } = appEnv();
    const prev = (await (
      await storageApp.request('/alice/r/purge/preview', { method: 'POST' }, e)
    ).json()) as { confirmToken: string };
    const res = await purge('/alice/r/purge', e, { confirmToken: prev.confirmToken });
    expect(res.status).toBe(202);
    expect(PURGE_WORKFLOW.create).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'purge:alice/r' }),
    );
    expect(await env.STORAGE.getByName('alice/r').activeOp()).toBe('purge');
  });

  test('501 while cold storage is enabled (not yet implemented)', async () => {
    await seedArchived('alice/r');
    const { env: e } = appEnv({}, { coldStorage: 's3.backup' });
    expect((await storageApp.request('/alice/r/purge/preview', { method: 'POST' }, e)).status).toBe(
      501,
    );
    expect((await purge('/alice/r/purge', e, {})).status).toBe(501);
  });
});
