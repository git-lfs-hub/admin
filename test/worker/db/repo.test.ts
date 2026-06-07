import { reset } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, test, expect, afterEach } from 'vitest';

afterEach(async () => {
  await reset();
});

describe('Repo.recordObject', () => {
  test('upload inserts as pending (R2 presence unconfirmed)', async () => {
    const row = await env.REPO.getByName('alice/thing').recordObject('oid1', 42, 'upload');
    expect(row.oid).toBe('oid1');
    expect(row.size).toBe(42);
    expect(row.source).toBe('upload');
    expect(row.status).toBe('pending');
    expect(row.firstSeen).toBe(row.lastSeen);
    expect(row.lastAccessed).toBe(row.firstSeen);
  });

  test('verify/download insert as present', async () => {
    expect((await env.REPO.getByName('a/v').recordObject('o', 1, 'verify')).status).toBe('present');
    expect((await env.REPO.getByName('a/d').recordObject('o', 1, 'download')).status).toBe(
      'present',
    );
  });

  test('verify confirms a pending upload to present', async () => {
    const repo = env.REPO.getByName('alice/thing');
    expect((await repo.recordObject('oid1', 1, 'upload')).status).toBe('pending');
    expect((await repo.recordObject('oid1', 1, 'verify')).status).toBe('present');
  });

  test('upload does not downgrade an already-present object', async () => {
    const repo = env.REPO.getByName('alice/thing');
    await repo.recordObject('oid1', 1, 'download');
    expect((await repo.recordObject('oid1', 1, 'upload')).status).toBe('present');
  });

  test('verify is stored as verify source', async () => {
    const row = await env.REPO.getByName('alice/thing').recordObject('oid1', 7, 'verify');
    expect(row.source).toBe('verify');
  });

  test('download is stored as download source', async () => {
    const row = await env.REPO.getByName('alice/thing').recordObject('oid1', 7, 'download');
    expect(row.source).toBe('download');
  });

  test('re-record preserves firstSeen, advances lastSeen', async () => {
    const repo = env.REPO.getByName('alice/thing');
    const a = await repo.recordObject('oid1', 10, 'upload');
    await new Promise((r) => setTimeout(r, 1100));
    const b = await repo.recordObject('oid1', 10, 'upload');
    expect(b.firstSeen).toBe(a.firstSeen);
    expect(b.lastSeen).not.toBe(a.lastSeen);
  });

  test('every event bumps lastAccessed', async () => {
    const repo = env.REPO.getByName('alice/thing');
    const a = await repo.recordObject('oid1', 10, 'upload');
    await new Promise((r) => setTimeout(r, 1100));
    const afterUpload = await repo.recordObject('oid1', 10, 'upload');
    expect(afterUpload.lastAccessed).not.toBe(a.lastAccessed);
  });

  test('separate repos get separate indexes', async () => {
    await env.REPO.getByName('alice/one').recordObject('oid1', 1, 'upload');
    expect(await env.REPO.getByName('alice/one').listObjects()).toHaveLength(1);
    expect(await env.REPO.getByName('alice/two').listObjects()).toHaveLength(0);
  });
});

describe('Repo.usage', () => {
  test('breaks down count and size per status', async () => {
    const repo = env.REPO.getByName('alice/thing');
    await repo.recordObject('p1', 10, 'download'); // present
    await repo.recordObject('p2', 5, 'verify'); // present
    await repo.recordObject('u1', 99, 'upload'); // pending
    const usage = await repo.usage();
    expect(usage.present).toEqual({ count: 2, size: 15 });
    expect(usage.pending).toEqual({ count: 1, size: 99 });
    expect(usage.missing).toEqual({ count: 0, size: 0 });
  });

  test('zero-fills every status for an empty index', async () => {
    expect(await env.REPO.getByName('alice/thing').usage()).toEqual({
      pending: { count: 0, size: 0 },
      present: { count: 0, size: 0 },
      missing: { count: 0, size: 0 },
      deleted: { count: 0, size: 0 },
      purged: { count: 0, size: 0 },
    });
  });
});

describe('Repo.lastAccessedAt', () => {
  test('returns null for an empty index', async () => {
    expect(await env.REPO.getByName('alice/thing').lastAccessedAt()).toBeNull();
  });

  test("returns the object's last_accessed", async () => {
    const repo = env.REPO.getByName('alice/thing');
    const row = await repo.recordObject('o1', 10, 'download');
    expect(await repo.lastAccessedAt()).toBe(row.lastAccessed);
  });
});

describe('Repo.recordReconciliation', () => {
  test('confirms pending, corrects sizes, and skips storage-absent objects', async () => {
    const repo = env.REPO.getByName('alice/thing');
    await repo.recordObject('pending', 7, 'upload'); // pending, in storage
    await repo.recordObject('wrong', 1, 'download'); // present, wrong size
    await repo.recordObject('orphan', 3, 'upload'); // pending, not in storage

    const res = await repo.recordReconciliation({ pending: 7, wrong: 42 });
    expect(res).toEqual({ added: 0, confirmed: 1, resized: 1 });
    expect((await repo.getObject('pending'))?.status).toBe('present');
    expect((await repo.getObject('wrong'))?.size).toBe(42);
    expect((await repo.getObject('orphan'))?.status).toBe('pending');
  });

  test('adds objects present in storage but missing from the index', async () => {
    const repo = env.REPO.getByName('alice/thing');
    const res = await repo.recordReconciliation({ found: 99 });
    expect(res).toEqual({ added: 1, confirmed: 0, resized: 0 });
    const row = await repo.getObject('found');
    expect(row?.size).toBe(99);
    expect(row?.status).toBe('present');
    expect(row?.source).toBe('storage_scan');
  });

  test("adds a batch larger than SQLite's bound-variable limit in one call", async () => {
    const repo = env.REPO.getByName('alice/thing');
    // >100 rows: a single multi-row insert would exceed the bound-var limit.
    const sizes = Object.fromEntries(Array.from({ length: 250 }, (_, i) => [`oid-${i}`, i + 1]));
    const res = await repo.recordReconciliation(sizes);
    expect(res).toEqual({ added: 250, confirmed: 0, resized: 0 });
    expect((await repo.getObject('oid-0'))?.size).toBe(1);
    expect((await repo.getObject('oid-249'))?.size).toBe(250);
  });
});
