import { reset, runInDurableObject } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { Hono } from 'hono';
import { describe, test, expect, afterEach, vi } from 'vitest';

import type { AppEnv } from '@/_env';
import storageApp from '@/api/storage';
import type { Registry } from '@/db/registry';

// The real worker gates `/api/*` with `auth`, which sets `c.var.admin`. Driving the sub-app
// directly skips that, so wrap it to inject the authed identity the way auth would.
const asAdmin = (admin: string) =>
  new Hono<AppEnv>()
    .use('*', async (c, next) => {
      c.set('admin', admin);
      await next();
    })
    .route('/', storageApp);

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
  // PURGE_WORKFLOW / BACKUP_WORKFLOW are omitted from the test wrangler (no workflow runtime in the
  // pool); stub create()/get() so the trigger path (beginOp on the real STORAGE DO + create) is
  // exercisable.
  const PURGE_WORKFLOW = { create: vi.fn(async () => {}), get: vi.fn() };
  const BACKUP_WORKFLOW = { create: vi.fn(async () => {}), get: vi.fn() };
  const RESTORE_WORKFLOW = { create: vi.fn(async () => {}), get: vi.fn() };
  const DELETE_BACKUP_WORKFLOW = { create: vi.fn(async () => {}), get: vi.fn() };
  const CLEAR_WORKFLOW = { create: vi.fn(async () => {}), get: vi.fn() };
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
      BACKUP_WORKFLOW,
      RESTORE_WORKFLOW,
      DELETE_BACKUP_WORKFLOW,
      CLEAR_WORKFLOW,
    } as unknown as CloudflareBindings & {
      PURGE_WORKFLOW: typeof PURGE_WORKFLOW;
      BACKUP_WORKFLOW: typeof BACKUP_WORKFLOW;
      RESTORE_WORKFLOW: typeof RESTORE_WORKFLOW;
      DELETE_BACKUP_WORKFLOW: typeof DELETE_BACKUP_WORKFLOW;
      CLEAR_WORKFLOW: typeof CLEAR_WORKFLOW;
    },
    blockRepo: LFS_SERVER.blockRepo,
    unblockRepo: LFS_SERVER.unblockRepo,
    purgeRepo: LFS_SERVER.purgeRepo,
    PURGE_WORKFLOW,
    BACKUP_WORKFLOW,
    RESTORE_WORKFLOW,
    DELETE_BACKUP_WORKFLOW,
    CLEAR_WORKFLOW,
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
  // Localhost fetch fires the dev reconcile. `design-assets` is storage only once R2 has objects
  // (not from the link), so seed one first; then its two linked repos read `used`.
  test('localhost bypass serves the dev fixture link graph (shared prefix, two consumers)', async () => {
    await env.LFS_BUCKET.put('test-org/design-assets/o1', 'x');
    const res = await exports.default.fetch('http://localhost/api/storage');
    expect(res.status).toBe(200);
    const { storage } = (await res.json()) as {
      storage: { prefix: string; status: string; gitRepos: { owner: string; repo: string }[] }[];
    };
    const shared = storage.find((s) => s.prefix === 'test-org/design-assets');
    expect(shared?.status).toBe('used');
    expect(shared?.gitRepos.map((g) => `${g.owner}/${g.repo}`).sort()).toEqual([
      'test-org/marketing-app',
      'test-org/marketing-site',
    ]);
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

  test('cross-links consumer git repos from links; empty when unlinked', async () => {
    await reg().upsertStorage('alice/a');
    await reg().upsertRepo('alice', 'a');
    await reg().syncLinks('alice', 'a', new Set(['alice/a']));
    await reg().upsertStorage('bob/orphan');

    const res = await exports.default.fetch('http://localhost/api/storage');
    const body = (await res.json()) as {
      storage: Array<{ repo: string; gitRepos: Array<{ status: string }> }>;
    };
    const byRepo = Object.fromEntries(body.storage.map((r) => [r.repo, r]));
    expect(byRepo.a.gitRepos).toEqual([{ owner: 'alice', repo: 'a', status: 'active' }]);
    expect(byRepo.orphan.gitRepos).toEqual([]);
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
    await env.STORAGE.getByName('alice/a').recordObject('oid1', 10, 'download');
    await env.STORAGE.getByName('alice/a').recordObject('oid2', 5, 'verify');
    await env.STORAGE.getByName('alice/a').recordObject('oid3', 7, 'upload');
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

    const archiveDays = env.GC.autoDays.archive;
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

    const retentionDays = env.GC.retentionDays.live;
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

  // Blocked + live cleared (the cold-restore state). No `markCleared` setter until F5, so stamp
  // `cleared_at` directly on the registry DO.
  async function seedCleared(prefix: string) {
    await seedBlocked(prefix);
    await runInDurableObject(reg(), (instance: Registry) => {
      (instance as unknown as { ctx: DurableObjectState }).ctx.storage.sql.exec(
        'UPDATE storage SET cleared_at = ? WHERE prefix = ?',
        '2026-02-01T00:00:00Z',
        prefix,
      );
    });
  }

  test('blocked prefix, repo still gone → unblockRepo + archivedAt cleared, status unused, emits missing', async () => {
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
    // The repo is still gone, so unblocking lands back on `unused` → emits `missing`, not
    // `restored` (serving didn't resume), and clears the prior `archived` alert.
    expect(
      await env.ALERTS.getByName('global').getAlert('storage:alice/gone', 'missing'),
    ).toMatchObject({
      kind: 'missing',
    });
    expect(
      await env.ALERTS.getByName('global').getAlert('storage:alice/gone', 'restored'),
    ).toBeNull();
    expect(
      await env.ALERTS.getByName('global').getAlert('storage:alice/gone', 'archived'),
    ).toBeNull();
  });

  test('cleared prefix (cold) → starts the RestoreWorkflow (beginOp restore + create) → 202', async () => {
    await seedCleared('alice/cold');
    const { env: e, RESTORE_WORKFLOW, unblockRepo } = appEnv();

    const res = await post('/alice/cold/restore', e);
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ status: 'restoring' });
    expect(RESTORE_WORKFLOW.create).toHaveBeenCalledWith(
      expect.objectContaining({ id: expect.stringMatching(/^restore-[0-9a-f-]{36}$/) }),
    );
    expect(await env.STORAGE.getByName('alice/cold').activeOp()).toBe('restore');
    expect(unblockRepo).not.toHaveBeenCalled(); // unblock is the workflow's finish step, not inline
  });

  test('cleared prefix already has an op in flight → 409 busy', async () => {
    await seedCleared('alice/cold');
    await env.STORAGE.getByName('alice/cold').beginOp('alice/cold', 'backup-x', 'backup');
    const { env: e, RESTORE_WORKFLOW } = appEnv();

    const res = await post('/alice/cold/restore', e);
    expect(res.status).toBe(409);
    expect(RESTORE_WORKFLOW.create).not.toHaveBeenCalled();
  });

  test('not-blocked prefix → 409, no unblock', async () => {
    await reg().upsertStorage('alice/live');
    const { env: e, unblockRepo } = appEnv();

    const res = await post('/alice/live/restore', e);
    expect(res.status).toBe(409);
    expect(unblockRepo).not.toHaveBeenCalled();
  });

  test('purged prefix → 409 already_purged, no unblock', async () => {
    await seedBlocked('alice/gone');
    await reg().markPurged('alice/gone');
    const { env: e, unblockRepo } = appEnv();

    const res = await post('/alice/gone/restore', e);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'already_purged' });
    expect(unblockRepo).not.toHaveBeenCalled();
  });

  test('in-flight purge → 409 busy, no unblock', async () => {
    await seedActivePurge('alice/r');
    const { env: e, unblockRepo } = appEnv();

    const res = await post('/alice/r/restore', e);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'busy' });
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

describe('POST /api/storage/:o/:r/clear (cold storage on)', () => {
  const cold = { coldStorage: 's3.backup' };

  // Stamp a complete cold copy on a blocked prefix — the clearable state.
  async function seedBackupComplete(prefix: string) {
    await seedArchived(prefix);
    await reg().endBackup(prefix, (await reg().getStorage(prefix))!.archivedAt); // backupComplete=true
  }

  // Preview → state-bound token → POST with that token (mirrors the purge confirm flow).
  const clearWithToken = async (e: CloudflareBindings) => {
    const prev = (await (
      await storageApp.request('/alice/r/clear/preview', { method: 'POST' }, e)
    ).json()) as { token?: string };
    return storageApp.request(
      '/alice/r/clear',
      {
        method: 'POST',
        body: JSON.stringify({ token: prev.token }),
        headers: { 'content-type': 'application/json' },
      },
      e,
    );
  };

  test('preview returns impact + a confirm token for a clearable prefix', async () => {
    await seedBackupComplete('alice/r');
    await env.STORAGE.getByName('alice/r').recordObject('oid1', 10, 'verify');
    const { env: e } = appEnv({}, cold);
    const res = await storageApp.request('/alice/r/clear/preview', { method: 'POST' }, e);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; impact: { objects: number } };
    expect(body.token).toMatch(/^[0-9a-f]{64}$/);
    expect(body.impact.objects).toBe(1);
  });

  test('stale/missing token → 409', async () => {
    await seedBackupComplete('alice/r');
    const { env: e } = appEnv({}, cold);
    const res = await storageApp.request(
      '/alice/r/clear',
      {
        method: 'POST',
        body: JSON.stringify({ token: 'nope' }),
        headers: { 'content-type': 'application/json' },
      },
      e,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'stale_token' });
  });

  test('complete backup, blocked, valid token → reserves the op (beginOp) + creates the instance → 202', async () => {
    await seedBackupComplete('alice/r');
    const { env: e, CLEAR_WORKFLOW } = appEnv({}, cold);
    const res = await clearWithToken(e);
    expect(res.status).toBe(202);
    expect(CLEAR_WORKFLOW.create).toHaveBeenCalledWith(
      expect.objectContaining({ id: expect.stringMatching(/^clear-[0-9a-f-]{36}$/) }),
    );
    expect(await env.STORAGE.getByName('alice/r').activeOp()).toBe('clear');
  });

  test('not blocked → 409 not_blocked', async () => {
    await seedUnused('alice/r');
    await reg().endBackup('alice/r', null); // backedUpAt set but never blocked → backupComplete false
    const { env: e } = appEnv({}, cold);
    const res = await post('/alice/r/clear', e);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'not_blocked' });
  });

  test('blocked but backup incomplete → 409 not_backed_up', async () => {
    await seedArchived('alice/r'); // blocked, no backup
    const { env: e } = appEnv({}, cold);
    const res = await post('/alice/r/clear', e);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'not_backed_up' });
  });

  test('already cleared → 409 already_cleared', async () => {
    await seedBackupComplete('alice/r');
    await reg().markCleared('alice/r');
    const { env: e } = appEnv({}, cold);
    const res = await post('/alice/r/clear', e);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'already_cleared' });
  });

  test('purged → 409 already_purged', async () => {
    await seedBackupComplete('alice/r');
    await reg().markPurged('alice/r');
    const { env: e } = appEnv({}, cold);
    const res = await post('/alice/r/clear', e);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'already_purged' });
  });

  test('busy (an op already in flight) → 409', async () => {
    await seedBackupComplete('alice/r');
    await env.STORAGE.getByName('alice/r').beginOp('alice/r', 'purge-x', 'purge');
    const { env: e } = appEnv({}, cold);
    expect((await clearWithToken(e)).status).toBe(409);
  });

  test('cold storage off → 409 cold_storage_disabled (config, not unimplemented)', async () => {
    await seedBackupComplete('alice/r');
    const { env: e } = appEnv(); // default: coldStorage ""
    const res = await post('/alice/r/clear', e);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'cold_storage_disabled' });
  });
});

describe('DELETE /api/storage/:o/:r/backup (cold storage on)', () => {
  const cold = { coldStorage: 's3.backup' };
  const del = (path: string, e: CloudflareBindings) =>
    storageApp.request(path, { method: 'DELETE' }, e);

  // Stamp a finished backup (cold copy exists, live still present) — the eligible state.
  async function seedBackedUp(prefix: string) {
    await seedArchived(prefix);
    await reg().endBackup(prefix, null); // sets backedUpAt, clearedAt stays null
  }

  test('backed-up prefix → reserves the op (beginOp) + creates the instance → 202', async () => {
    await seedBackedUp('alice/r');
    const { env: e, DELETE_BACKUP_WORKFLOW } = appEnv({}, cold);
    const res = await del('/alice/r/backup', e);
    expect(res.status).toBe(202);
    expect(DELETE_BACKUP_WORKFLOW.create).toHaveBeenCalledWith(
      expect.objectContaining({ id: expect.stringMatching(/^deleteBackup-[0-9a-f-]{36}$/) }),
    );
    expect(await env.STORAGE.getByName('alice/r').activeOp()).toBe('deleteBackup');
  });

  test('no cold copy (backedUpAt null) → 409 no_backup', async () => {
    await seedArchived('alice/r');
    const { env: e } = appEnv({}, cold);
    const res = await del('/alice/r/backup', e);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'no_backup' });
  });

  test('live cleared (cold is the only copy) → 409 cleared', async () => {
    await seedBackedUp('alice/r');
    // No `markCleared` setter until F5, so stamp `cleared_at` directly on the registry DO.
    await runInDurableObject(reg(), (instance: Registry) => {
      (instance as unknown as { ctx: DurableObjectState }).ctx.storage.sql.exec(
        'UPDATE storage SET cleared_at = ? WHERE prefix = ?',
        '2026-03-01T00:00:00Z',
        'alice/r',
      );
    });
    const { env: e } = appEnv({}, cold);
    const res = await del('/alice/r/backup', e);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'cleared' });
  });

  test('busy (an op already in flight) → 409', async () => {
    await seedBackedUp('alice/r');
    await env.STORAGE.getByName('alice/r').beginOp('alice/r', 'purge-x', 'purge');
    const { env: e } = appEnv({}, cold);
    expect((await del('/alice/r/backup', e)).status).toBe(409);
  });

  test('cold storage off → 409 cold_storage_disabled (config, not unimplemented)', async () => {
    await seedBackedUp('alice/r');
    const { env: e } = appEnv(); // default: coldStorage ""
    const res = await del('/alice/r/backup', e);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'cold_storage_disabled' });
  });
});

describe('POST /api/storage/:o/:r/backup (cold storage on)', () => {
  const cold = { coldStorage: 's3.backup' };

  test('non-purged prefix → reserves the op (beginOp) + creates the instance → 202', async () => {
    await seedUnused('alice/r');
    const { env: e, BACKUP_WORKFLOW } = appEnv({}, cold);
    const res = await post('/alice/r/backup', e);
    expect(res.status).toBe(202);
    expect(BACKUP_WORKFLOW.create).toHaveBeenCalledWith(
      expect.objectContaining({ id: expect.stringMatching(/^backup-[0-9a-f-]{36}$/) }),
    );
    expect(await env.STORAGE.getByName('alice/r').activeOp()).toBe('backup');
  });

  test('runs on a blocked prefix too (admin pre-warm allowed)', async () => {
    await seedArchived('alice/r');
    const { env: e } = appEnv({}, cold);
    expect((await post('/alice/r/backup', e)).status).toBe(202);
  });

  test('purged prefix → 409', async () => {
    await seedArchived('alice/r');
    await reg().markPurged('alice/r');
    const { env: e } = appEnv({}, cold);
    expect((await post('/alice/r/backup', e)).status).toBe(409);
  });

  test('busy (an op already in flight) → 409', async () => {
    await seedUnused('alice/r');
    await env.STORAGE.getByName('alice/r').beginOp('alice/r', 'purge-x', 'purge');
    const { env: e } = appEnv({}, cold);
    expect((await post('/alice/r/backup', e)).status).toBe(409);
  });

  test('cold storage off → 409 cold_storage_disabled (config, not unimplemented)', async () => {
    await seedUnused('alice/r');
    const { env: e } = appEnv(); // default: coldStorage ""
    const res = await post('/alice/r/backup', e);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'cold_storage_disabled' });
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
    const body = (await res.json()) as { token: string; impact: { objects: number } };
    expect(body.token).toMatch(/^[0-9a-f]{64}$/);
    expect(body.impact.objects).toBe(1);
  });

  test('preview/POST 409 not_blocked for a live (used) prefix', async () => {
    await reg().upsertStorage('alice/live'); // status 'used', never archived
    const { env: e } = appEnv();
    const prev = await storageApp.request('/alice/live/purge/preview', { method: 'POST' }, e);
    expect(prev.status).toBe(409);
    expect(await prev.json()).toMatchObject({ error: 'not_blocked' });
    expect((await purge('/alice/live/purge', e, { token: 'x' })).status).toBe(409);
  });

  test('unused prefix → archives inline (blockRepo, no backup) then starts the workflow → 202', async () => {
    await seedUnused('alice/r');
    const {
      env: e,
      PURGE_WORKFLOW,
      BACKUP_WORKFLOW,
      blockRepo,
    } = appEnv({}, { coldStorage: 's3.backup' });
    const prev = (await (
      await storageApp.request('/alice/r/purge/preview', { method: 'POST' }, e)
    ).json()) as { token: string };
    const res = await purge('/alice/r/purge', e, { token: prev.token });
    expect(res.status).toBe(202);
    expect(blockRepo).toHaveBeenCalledWith('alice', 'r');
    expect(BACKUP_WORKFLOW.create).not.toHaveBeenCalled(); // no backup on the direct-purge path
    expect(PURGE_WORKFLOW.create).toHaveBeenCalled();
    const row = await reg().getStorage('alice/r');
    expect(row?.archivedAt).toBeTruthy(); // archived inline
    expect(row?.activeOp).toBe('purge');
  });

  test('unused prefix, blockRepo fails → 502, nothing reserved', async () => {
    await seedUnused('alice/r');
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { env: e, PURGE_WORKFLOW } = appEnv({
      blockRepo: vi.fn(async () => {
        throw new Error('rpc down');
      }),
    });
    const prev = (await (
      await storageApp.request('/alice/r/purge/preview', { method: 'POST' }, e)
    ).json()) as { token: string };
    const res = await purge('/alice/r/purge', e, { token: prev.token });
    expect(res.status).toBe(502);
    expect(PURGE_WORKFLOW.create).not.toHaveBeenCalled();
    expect((await reg().getStorage('alice/r'))?.archivedAt).toBeNull();
    warn.mockRestore();
  });

  test('409 in_use when an active git repo links the prefix', async () => {
    await seedArchived('alice/r');
    await reg().upsertRepo('alice', 'r');
    await reg().syncLinks('alice', 'r', new Set(['alice/r'])); // active link → prefix in use
    const { env: e } = appEnv();
    const res = await storageApp.request('/alice/r/purge/preview', { method: 'POST' }, e);
    expect(await res.json()).toMatchObject({ error: 'in_use' });
    expect(res.status).toBe(409);
  });

  test('stale/missing token → 409', async () => {
    await seedArchived('alice/r');
    const { env: e } = appEnv();
    expect((await purge('/alice/r/purge', e, { token: 'nope' })).status).toBe(409);
  });

  test('valid token → starts the workflow (beginOp reserved + create called) → 202', async () => {
    await seedArchived('alice/r');
    const { env: e, PURGE_WORKFLOW } = appEnv();
    const prev = (await (
      await storageApp.request('/alice/r/purge/preview', { method: 'POST' }, e)
    ).json()) as { token: string };
    const res = await purge('/alice/r/purge', e, { token: prev.token });
    expect(res.status).toBe(202);
    expect(PURGE_WORKFLOW.create).toHaveBeenCalledWith(
      expect.objectContaining({ id: expect.stringMatching(/^purge-[0-9a-f-]{36}$/) }),
    );
    expect(await env.STORAGE.getByName('alice/r').activeOp()).toBe('purge');
  });

  test('busy (a different op already in flight) → 409', async () => {
    await seedArchived('alice/r');
    await env.STORAGE.getByName('alice/r').beginOp('alice/r', 'backup-x', 'backup');
    const { env: e, PURGE_WORKFLOW } = appEnv();
    const prev = (await (
      await storageApp.request('/alice/r/purge/preview', { method: 'POST' }, e)
    ).json()) as { token: string };
    const res = await purge('/alice/r/purge', e, { token: prev.token });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'busy' });
    expect(PURGE_WORKFLOW.create).not.toHaveBeenCalled();
  });

  test('cold storage enabled → purge passes the gate (preview 200, valid token → 202)', async () => {
    await seedArchived('alice/r');
    const { env: e, PURGE_WORKFLOW } = appEnv({}, { coldStorage: 's3.backup' });
    const prev = (await (
      await storageApp.request('/alice/r/purge/preview', { method: 'POST' }, e)
    ).json()) as { token: string };
    const res = await purge('/alice/r/purge', e, { token: prev.token });
    expect(res.status).toBe(202);
    expect(PURGE_WORKFLOW.create).toHaveBeenCalled();
  });
});

// Reserve a purge op so the prefix reads `activeOp = 'purge'` (the in-flight workflow state).
async function seedActivePurge(prefix: string) {
  await seedArchived(prefix);
  await env.STORAGE.getByName(prefix).beginOp(prefix, `purge-${crypto.randomUUID()}`, 'purge');
}

describe('in-flight purge workflow', () => {
  test('GET surfaces activeOp + purgeConfirmBy = updatedAt + GC.confirmDays', async () => {
    await seedActivePurge('alice/r');
    const res = await exports.default.fetch('http://localhost/api/storage');
    const body = (await res.json()) as {
      storage: Array<{
        repo: string;
        activeOp: string | null;
        updatedAt: string;
        purgeConfirmBy: string | null;
      }>;
    };
    const row = body.storage.find((r) => r.repo === 'r')!;
    expect(row.activeOp).toBe('purge');
    const expected = new Date(row.updatedAt).getTime() + env.GC.confirmDays * 24 * 60 * 60 * 1000;
    expect(new Date(row.purgeConfirmBy!).getTime()).toBe(expected);
  });

  test('confirm → records approve + wakes the workflow', async () => {
    await seedActivePurge('alice/r');
    await env.ALERTS.getByName('global').sendConfirmation({
      kind: 'purge',
      scope: 'storage:alice/r',
    });
    const instance = { sendEvent: vi.fn(async () => {}) };
    const { env: e, PURGE_WORKFLOW } = appEnv();
    PURGE_WORKFLOW.get.mockResolvedValue(instance);

    const res = await post('/alice/r/workflow/confirm', e);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'confirmed' });
    expect(
      (await env.ALERTS.getByName('global').getAlert('storage:alice/r', 'purge'))?.decision,
    ).toBe('approve');
    expect(instance.sendEvent).toHaveBeenCalled();
  });

  test('confirm with no active op → 409', async () => {
    await seedArchived('alice/r'); // archived but no workflow in flight
    const { env: e } = appEnv();
    expect((await post('/alice/r/workflow/confirm', e)).status).toBe(409);
  });

  test('confirm with no alert row → repairs alert + wakes the workflow', async () => {
    await seedActivePurge('alice/r');
    const instance = { sendEvent: vi.fn(async () => {}) };
    const { env: e, PURGE_WORKFLOW } = appEnv();
    PURGE_WORKFLOW.get.mockResolvedValue(instance);

    const res = await post('/alice/r/workflow/confirm', e);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'confirmed' });
    expect(
      (await env.ALERTS.getByName('global').getAlert('storage:alice/r', 'purge'))?.decision,
    ).toBe('approve');
    expect(instance.sendEvent).toHaveBeenCalled();
  });

  test('confirm when already approved → 409, no wake', async () => {
    await seedActivePurge('alice/r');
    await env.ALERTS.getByName('global').sendConfirmation({
      kind: 'purge',
      scope: 'storage:alice/r',
    });
    await env.ALERTS.getByName('global').decide('storage:alice/r', 'purge', 'approve', 'slack:u1');
    const instance = { sendEvent: vi.fn(async () => {}) };
    const { env: e, PURGE_WORKFLOW } = appEnv();
    PURGE_WORKFLOW.get.mockResolvedValue(instance);

    const res = await post('/alice/r/workflow/confirm', e);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'already' });
    expect(instance.sendEvent).not.toHaveBeenCalled();
  });

  test('cancel → terminates the instance + clears activeOp, status unchanged', async () => {
    await seedActivePurge('alice/r');
    await env.ALERTS.getByName('global').sendConfirmation({
      kind: 'purge',
      scope: 'storage:alice/r',
    });
    const instance = { terminate: vi.fn(async () => {}) };
    const { env: e, PURGE_WORKFLOW } = appEnv();
    PURGE_WORKFLOW.get.mockResolvedValue(instance);

    const res = await post('/alice/r/workflow/cancel', e);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'cancelled' });
    expect(instance.terminate).toHaveBeenCalled();
    const row = await reg().getStorage('alice/r');
    expect(row?.activeOp).toBeNull();
    expect(row?.status).toBe('unused'); // resting status untouched
    expect(await env.STORAGE.getByName('alice/r').activeOp()).toBeNull();
  });

  test('cancel survives a missing/finished instance (still clears the op)', async () => {
    await seedActivePurge('alice/r');
    await env.ALERTS.getByName('global').sendConfirmation({
      kind: 'purge',
      scope: 'storage:alice/r',
    });
    const { env: e, PURGE_WORKFLOW } = appEnv();
    PURGE_WORKFLOW.get.mockResolvedValue(undefined); // instance already gone → terminate throws

    const res = await post('/alice/r/workflow/cancel', e);
    expect(res.status).toBe(200);
    expect((await reg().getStorage('alice/r'))?.activeOp).toBeNull();
  });

  test('cancel with no active op → 409', async () => {
    await seedArchived('alice/r');
    const { env: e } = appEnv();
    expect((await post('/alice/r/workflow/cancel', e)).status).toBe(409);
  });

  test('cancel with no alert row → repairs alert + clears activeOp', async () => {
    await seedActivePurge('alice/r');
    const instance = { terminate: vi.fn(async () => {}) };
    const { env: e, PURGE_WORKFLOW } = appEnv();
    PURGE_WORKFLOW.get.mockResolvedValue(instance);

    const res = await post('/alice/r/workflow/cancel', e);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'cancelled' });
    expect(instance.terminate).toHaveBeenCalled();
    expect(
      (await env.ALERTS.getByName('global').getAlert('storage:alice/r', 'purge'))?.decision,
    ).toBe('cancel');
    expect(await env.STORAGE.getByName('alice/r').activeOp()).toBeNull();
  });

  test('cancel when already cancelled still clears activeOp (e.g. Slack cancel, then UI endOp)', async () => {
    await seedActivePurge('alice/r');
    await env.ALERTS.getByName('global').sendConfirmation({
      kind: 'purge',
      scope: 'storage:alice/r',
    });
    await env.ALERTS.getByName('global').decide('storage:alice/r', 'purge', 'cancel', 'slack:u1');
    const instance = { terminate: vi.fn(async () => {}) };
    const { env: e, PURGE_WORKFLOW } = appEnv();
    PURGE_WORKFLOW.get.mockResolvedValue(instance);

    const res = await post('/alice/r/workflow/cancel', e);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'cancelled' });
    expect(instance.terminate).toHaveBeenCalled();
    expect(await env.STORAGE.getByName('alice/r').activeOp()).toBeNull();
  });

  test('confirm/cancel unknown prefix → 404', async () => {
    const { env: e } = appEnv();
    expect((await post('/nobody/nope/workflow/confirm', e)).status).toBe(404);
    expect((await post('/nobody/nope/workflow/cancel', e)).status).toBe(404);
  });

  test('confirm records the authed admin (not a hardcoded actor) as decidedBy', async () => {
    await seedActivePurge('alice/r');
    const instance = { sendEvent: vi.fn(async () => {}) };
    const { env: e, PURGE_WORKFLOW } = appEnv();
    PURGE_WORKFLOW.get.mockResolvedValue(instance);

    const res = await asAdmin('octocat').request(
      '/alice/r/workflow/confirm',
      { method: 'POST' },
      e,
    );
    expect(res.status).toBe(200);
    expect(
      (await env.ALERTS.getByName('global').getAlert('storage:alice/r', 'purge'))?.decidedBy,
    ).toBe('admin:octocat');
  });

  test('cancel records the authed admin as decidedBy', async () => {
    await seedActivePurge('alice/r');
    await env.ALERTS.getByName('global').sendConfirmation({
      kind: 'purge',
      scope: 'storage:alice/r',
    });
    const instance = { terminate: vi.fn(async () => {}) };
    const { env: e, PURGE_WORKFLOW } = appEnv();
    PURGE_WORKFLOW.get.mockResolvedValue(instance);

    const res = await asAdmin('octocat').request('/alice/r/workflow/cancel', { method: 'POST' }, e);
    expect(res.status).toBe(200);
    expect(
      (await env.ALERTS.getByName('global').getAlert('storage:alice/r', 'purge'))?.decidedBy,
    ).toBe('admin:octocat');
  });
});
