import { Hono } from 'hono';
import { describe, test, expect, beforeEach, vi } from 'vitest';

// Per-org mutation scoping (worker/api/storage.ts `requireOwnerAdmin`). The DB layer is
// mocked so a write that passes the guard surfaces as the handler's own result (404 here),
// distinguishing "guard let it through" (404) from "guard blocked it" (403).
const registryMock = {
  getStorageByPrefix: vi.fn(async () => null as unknown),
  listActiveStorageLinks: vi.fn(async () => [] as unknown[]),
  listStorage: vi.fn(async () => [] as unknown[]),
};
const storageMock = {
  usage: vi.fn(async () => ({ present: { count: 1, size: 1 } })),
  lastAccessedAt: vi.fn(async () => null),
};

vi.mock('@/db/registry', () => ({ Registry: { global: () => registryMock } }));
vi.mock('@/db/storage', () => ({ Storage: { byPrefix: () => storageMock } }));
vi.mock('@/gc/config', () => ({
  gcConfig: () => ({
    coldStorage: '',
    autoDays: { archive: 7, clear: 30 },
    retentionDays: { live: 30, cold: 365 },
    confirmDays: 3,
  }),
}));

import storageApi from '@/api/storage';

// Caller is an admin of org-a only.
function api() {
  return { orgRole: async (org: string) => (org === 'org-a' ? 'admin' : 'member') };
}

function createApp() {
  return new Hono()
    .use('*', async (c, next) => {
      (c as any).set('admin', 'alice');
      (c as any).set('adminOrgs', ['org-a']);
      (c as any).set('api', api());
      await next();
    })
    .route('/api/storage', storageApi as any);
}

function post(path: string, host = 'admin.example.com') {
  return createApp().request(`http://${host}${path}`, { method: 'POST' }, {});
}

function del(path: string, host = 'admin.example.com') {
  return createApp().request(`http://${host}${path}`, { method: 'DELETE' }, {});
}

describe('storage mutation scoping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registryMock.getStorageByPrefix.mockResolvedValue(null);
  });

  test('archive on an owner the caller does not admin → 403, never touches the DB', async () => {
    const res = await post('/api/storage/org-b/repo/archive');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden' });
    expect(registryMock.getStorageByPrefix).not.toHaveBeenCalled();
  });

  test('archive on an owner the caller admins passes the guard (reaches handler → 404)', async () => {
    const res = await post('/api/storage/org-a/repo/archive');
    expect(res.status).toBe(404); // withStorage ran (guard passed); row absent
    expect(registryMock.getStorageByPrefix).toHaveBeenCalledWith('org-a/repo');
  });

  test('purge on a non-admin owner → 403', async () => {
    const res = await post('/api/storage/org-b/repo/purge');
    expect(res.status).toBe(403);
  });

  test('clear is guarded + resolved, then gated on cold storage', async () => {
    expect((await post('/api/storage/org-b/repo/clear')).status).toBe(403); // guard blocks
    registryMock.getStorageByPrefix.mockResolvedValue({ prefix: 'org-a/repo' }); // row exists
    const res = await post('/api/storage/org-a/repo/clear');
    expect(res.status).toBe(409); // guard + withStorage passed; cold storage off in this mock
    expect(await res.json()).toEqual({ error: 'cold_storage_disabled' });
  });

  test('delete-backup is guarded + resolved, then gated on cold storage', async () => {
    expect((await del('/api/storage/org-b/repo/backup')).status).toBe(403); // guard blocks
    registryMock.getStorageByPrefix.mockResolvedValue({ prefix: 'org-a/repo', backedUpAt: 'x' });
    const res = await del('/api/storage/org-a/repo/backup');
    expect(res.status).toBe(409); // guard + withStorage passed; cold storage off in this mock
    expect(await res.json()).toEqual({ error: 'cold_storage_disabled' });
  });

  test('local dev bypasses the owner check', async () => {
    const res = await post('/api/storage/org-b/repo/archive', 'localhost');
    expect(res.status).toBe(404); // guard skipped on localhost → withStorage → no row
  });

  test('GET listing stays global — returns rows for every owner, unscoped', async () => {
    const row = (prefix: string) => ({
      prefix,
      status: 'used',
      archivedAt: null,
      unusedAt: null,
      updatedAt: '2026-05-24T12:00:00Z',
      activeOp: null,
    });
    registryMock.listStorage.mockResolvedValue([row('org-a/r1'), row('org-b/r2')]);
    const res = await createApp().request('http://admin.example.com/api/storage', {}, {});
    expect(res.status).toBe(200);
    const { storage } = (await res.json()) as { storage: { owner: string }[] };
    expect(storage.map((s) => s.owner).sort()).toEqual(['org-a', 'org-b']);
  });
});
