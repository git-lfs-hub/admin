import { reset, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, test, expect, afterEach } from 'vitest';

import type { Storage } from '@/db/storage';

afterEach(async () => {
  await reset();
});

describe('Storage.recordObject', () => {
  test('upload inserts as pending (R2 presence unconfirmed)', async () => {
    const row = await env.STORAGE.getByName('alice/thing').recordObject('oid1', 42, 'upload');
    expect(row.oid).toBe('oid1');
    expect(row.size).toBe(42);
    expect(row.source).toBe('upload');
    expect(row.status).toBe('pending');
    expect(row.firstSeen).toBe(row.lastSeen);
    expect(row.lastAccessed).toBe(row.firstSeen);
  });

  test('verify/download insert as present', async () => {
    expect((await env.STORAGE.getByName('a/v').recordObject('o', 1, 'verify')).status).toBe(
      'present',
    );
    expect((await env.STORAGE.getByName('a/d').recordObject('o', 1, 'download')).status).toBe(
      'present',
    );
  });

  test('verify confirms a pending upload to present', async () => {
    const store = env.STORAGE.getByName('alice/thing');
    expect((await store.recordObject('oid1', 1, 'upload')).status).toBe('pending');
    expect((await store.recordObject('oid1', 1, 'verify')).status).toBe('present');
  });

  test('upload does not downgrade an already-present object', async () => {
    const store = env.STORAGE.getByName('alice/thing');
    await store.recordObject('oid1', 1, 'download');
    expect((await store.recordObject('oid1', 1, 'upload')).status).toBe('present');
  });

  test('verify is stored as verify source', async () => {
    const row = await env.STORAGE.getByName('alice/thing').recordObject('oid1', 7, 'verify');
    expect(row.source).toBe('verify');
  });

  test('download is stored as download source', async () => {
    const row = await env.STORAGE.getByName('alice/thing').recordObject('oid1', 7, 'download');
    expect(row.source).toBe('download');
  });

  test('re-record preserves firstSeen, advances lastSeen', async () => {
    const store = env.STORAGE.getByName('alice/thing');
    const a = await store.recordObject('oid1', 10, 'upload');
    await new Promise((r) => setTimeout(r, 1100));
    const b = await store.recordObject('oid1', 10, 'upload');
    expect(b.firstSeen).toBe(a.firstSeen);
    expect(b.lastSeen).not.toBe(a.lastSeen);
  });

  test('every event bumps lastAccessed', async () => {
    const store = env.STORAGE.getByName('alice/thing');
    const a = await store.recordObject('oid1', 10, 'upload');
    await new Promise((r) => setTimeout(r, 1100));
    const afterUpload = await store.recordObject('oid1', 10, 'upload');
    expect(afterUpload.lastAccessed).not.toBe(a.lastAccessed);
  });

  test('separate prefixes get separate indexes', async () => {
    await env.STORAGE.getByName('alice/one').recordObject('oid1', 1, 'upload');
    expect(await env.STORAGE.getByName('alice/one').listObjects()).toHaveLength(1);
    expect(await env.STORAGE.getByName('alice/two').listObjects()).toHaveLength(0);
  });
});

describe('Storage.usage', () => {
  test('breaks down count and size per status', async () => {
    const store = env.STORAGE.getByName('alice/thing');
    await store.recordObject('p1', 10, 'download'); // present
    await store.recordObject('p2', 5, 'verify'); // present
    await store.recordObject('u1', 99, 'upload'); // pending
    const usage = await store.usage();
    expect(usage.present).toEqual({ count: 2, size: 15 });
    expect(usage.pending).toEqual({ count: 1, size: 99 });
    expect(usage.missing).toEqual({ count: 0, size: 0 });
  });

  test('zero-fills every status for an empty index', async () => {
    expect(await env.STORAGE.getByName('alice/thing').usage()).toEqual({
      pending: { count: 0, size: 0 },
      present: { count: 0, size: 0 },
      missing: { count: 0, size: 0 },
      deleted: { count: 0, size: 0 },
      purged: { count: 0, size: 0 },
    });
  });
});

describe('Storage.lastAccessedAt', () => {
  test('returns null for an empty index', async () => {
    expect(await env.STORAGE.getByName('alice/thing').lastAccessedAt()).toBeNull();
  });

  test("returns the object's last_accessed", async () => {
    const store = env.STORAGE.getByName('alice/thing');
    const row = await store.recordObject('o1', 10, 'download');
    expect(await store.lastAccessedAt()).toBe(row.lastAccessed);
  });
});

describe('Storage.recordReconciliation', () => {
  test('confirms pending, corrects sizes, and skips storage-absent objects', async () => {
    const store = env.STORAGE.getByName('alice/thing');
    await store.recordObject('pending', 7, 'upload'); // pending, in storage
    await store.recordObject('wrong', 1, 'download'); // present, wrong size
    await store.recordObject('orphan', 3, 'upload'); // pending, not in storage

    const res = await store.recordReconciliation({ pending: 7, wrong: 42 });
    expect(res).toEqual({ added: 0, confirmed: 1, resized: 1 });
    expect((await store.getObject('pending'))?.status).toBe('present');
    expect((await store.getObject('wrong'))?.size).toBe(42);
    expect((await store.getObject('orphan'))?.status).toBe('pending');
  });

  test('adds objects present in storage but missing from the index', async () => {
    const store = env.STORAGE.getByName('alice/thing');
    const res = await store.recordReconciliation({ found: 99 });
    expect(res).toEqual({ added: 1, confirmed: 0, resized: 0 });
    const row = await store.getObject('found');
    expect(row?.size).toBe(99);
    expect(row?.status).toBe('present');
    expect(row?.source).toBe('storage_scan');
  });

  test("adds a batch larger than SQLite's bound-variable limit in one call", async () => {
    const store = env.STORAGE.getByName('alice/thing');
    // >100 rows: a single multi-row insert would exceed the bound-var limit.
    const sizes = Object.fromEntries(Array.from({ length: 250 }, (_, i) => [`oid-${i}`, i + 1]));
    const res = await store.recordReconciliation(sizes);
    expect(res).toEqual({ added: 250, confirmed: 0, resized: 0 });
    expect((await store.getObject('oid-0'))?.size).toBe(1);
    expect((await store.getObject('oid-249'))?.size).toBe(250);
  });
});

describe('Storage workflows (one-active-op guard)', () => {
  test('beginOp records an active row and denormalizes activeOp to REGISTRY', async () => {
    const registry = env.REGISTRY.getByName('global');
    await registry.upsertStorage('alice/thing');
    const store = env.STORAGE.getByName('alice/thing');

    const row = await store.beginOp('alice/thing', 'inst-1', 'backup');
    expect(row.op).toBe('backup');
    expect(row.endedAt).toBeNull();
    expect(await store.activeOp()).toBe('backup');
    expect((await registry.getStorage('alice/thing'))?.activeOp).toBe('backup');
  });

  test('refuses a second, different op while busy', async () => {
    const registry = env.REGISTRY.getByName('global');
    await registry.upsertStorage('alice/thing');
    const store = env.STORAGE.getByName('alice/thing');
    await store.beginOp('alice/thing', 'inst-1', 'backup');
    // Assert the throw inside the DO instance — a rejection across the RPC boundary surfaces
    // as an unhandled remote error in vitest-pool-workers even when the caller catches it.
    await runInDurableObject(store, async (instance: Storage) => {
      await expect(instance.beginOp('alice/thing', 'inst-2', 'purge')).rejects.toThrow(/busy/);
    });
  });

  test('allows another shard of the same op', async () => {
    const registry = env.REGISTRY.getByName('global');
    await registry.upsertStorage('alice/thing');
    const store = env.STORAGE.getByName('alice/thing');
    await store.beginOp('alice/thing', 'inst-1', 'backup', 0);
    const shard1 = await store.beginOp('alice/thing', 'inst-2', 'backup', 1);
    expect(shard1.shard).toBe(1);
  });

  test('endOp on the last active row writes resting status + clears activeOp on REGISTRY', async () => {
    const registry = env.REGISTRY.getByName('global');
    await registry.upsertStorage('alice/thing');
    const store = env.STORAGE.getByName('alice/thing');
    await store.beginOp('alice/thing', 'inst-1', 'purge');

    await store.endOp('alice/thing', 'inst-1', 'complete', 'purged');
    expect(await store.activeOp()).toBeNull();
    const row = await registry.getStorage('alice/thing');
    expect(row?.status).toBe('purged');
    expect(row?.activeOp).toBeNull();
    expect(row?.purgedAt).not.toBeNull();
  });

  test('endBackupOp lands backedUpAt/backupComplete (not status) when last shard ends', async () => {
    const registry = env.REGISTRY.getByName('global');
    await registry.upsertStorage('alice/thing');
    await registry.markUnused('alice/thing');
    const blocked = await registry.block('alice/thing');
    const store = env.STORAGE.getByName('alice/thing');
    await store.beginOp('alice/thing', 'inst-1', 'backup');

    await store.endBackupOp('alice/thing', 'inst-1', blocked!.archivedAt);
    expect(await store.activeOp()).toBeNull();
    const row = await registry.getStorage('alice/thing');
    expect(row?.status).toBe('unused'); // BackUp never moves resting status
    expect(row?.backedUpAt).not.toBeNull();
    expect(row?.backupComplete).toBe(true);
    expect(row?.activeOp).toBeNull();
  });

  test('endBackupOp defers the REGISTRY write until the last shard closes', async () => {
    const registry = env.REGISTRY.getByName('global');
    await registry.upsertStorage('alice/thing');
    const store = env.STORAGE.getByName('alice/thing');
    await store.beginOp('alice/thing', 'inst-1', 'backup', 0);
    await store.beginOp('alice/thing', 'inst-2', 'backup', 1);

    await store.endBackupOp('alice/thing', 'inst-1', null);
    expect((await registry.getStorage('alice/thing'))?.backedUpAt).toBeNull(); // shard 1 still active
    await store.endBackupOp('alice/thing', 'inst-2', null);
    expect((await registry.getStorage('alice/thing'))?.backedUpAt).not.toBeNull();
  });

  test('listWorkflows returns every row, active and closed', async () => {
    const registry = env.REGISTRY.getByName('global');
    await registry.upsertStorage('alice/thing');
    const store = env.STORAGE.getByName('alice/thing');
    await store.beginOp('alice/thing', 'inst-1', 'backup');
    await store.endOp('alice/thing', 'inst-1', 'complete', 'used');
    await store.beginOp('alice/thing', 'inst-2', 'restore');
    const rows = await store.listWorkflows();
    expect(rows.map((r) => r.instanceId).sort()).toEqual(['inst-1', 'inst-2']);
  });

  test('requestCancel flags all active rows', async () => {
    const registry = env.REGISTRY.getByName('global');
    await registry.upsertStorage('alice/thing');
    const store = env.STORAGE.getByName('alice/thing');
    await store.beginOp('alice/thing', 'inst-1', 'backup', 0);
    await store.beginOp('alice/thing', 'inst-2', 'backup', 1);
    expect(await store.requestCancel()).toBe(2);
  });
});
