import { reset } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, test, expect, afterEach } from 'vitest';

import { reconcileObjects } from '@/reconcile/objects';

afterEach(async () => {
  await reset();
});

async function seedR2(entries: [string, number][]) {
  for (const [k, size] of entries) await env.LFS_BUCKET.put(k, 'x'.repeat(size));
}

describe('reconcileObjects', () => {
  test('confirms pending objects present in R2', async () => {
    const store = env.STORAGE.getByName('alice/repo');
    await store.recordObject('oid1', 10, 'upload'); // pending
    await seedR2([['alice/repo/oid1', 10]]);

    const res = await reconcileObjects(env.LFS_BUCKET, store, 'alice/repo/');
    expect(res.confirmed).toBe(1);
    expect((await store.getObject('oid1'))?.status).toBe('present');
  });

  test('populates a mismatched size from R2 truth', async () => {
    const store = env.STORAGE.getByName('alice/repo');
    await store.recordObject('oid1', 999, 'download'); // present, wrong size
    await seedR2([['alice/repo/oid1', 42]]);

    const res = await reconcileObjects(env.LFS_BUCKET, store, 'alice/repo/');
    expect(res.resized).toBe(1);
    expect((await store.getObject('oid1'))?.size).toBe(42);
  });

  test('adds storage objects missing from the index', async () => {
    const store = env.STORAGE.getByName('alice/repo');
    await seedR2([['alice/repo/orphan', 8]]);

    const res = await reconcileObjects(env.LFS_BUCKET, store, 'alice/repo/');
    expect(res.added).toBe(1);
    const row = await store.getObject('orphan');
    expect(row?.size).toBe(8);
    expect(row?.status).toBe('present');
    expect(row?.source).toBe('storage_scan');
  });

  test('leaves a pending object (presigned, never uploaded) untouched', async () => {
    const store = env.STORAGE.getByName('alice/repo');
    await store.recordObject('gone', 5, 'upload'); // pending, never landed in R2

    const res = await reconcileObjects(env.LFS_BUCKET, store, 'alice/repo/');
    expect(res).toEqual({ added: 0, confirmed: 0, resized: 0, present: 0, missing: 0 });
    expect((await store.getObject('gone'))?.status).toBe('pending');
  });

  test('marks a present row whose bytes vanished as missing (empty prefix)', async () => {
    const store = env.STORAGE.getByName('alice/repo');
    await store.recordObject('vanished', 7, 'verify'); // present, no R2 bytes

    const res = await reconcileObjects(env.LFS_BUCKET, store, 'alice/repo/');
    expect(res.missing).toBe(1);
    expect((await store.getObject('vanished'))?.status).toBe('missing');
  });

  test('recovers a missing row when its bytes reappear', async () => {
    const store = env.STORAGE.getByName('alice/repo');
    await store.recordObject('back', 4, 'verify');
    await reconcileObjects(env.LFS_BUCKET, store, 'alice/repo/'); // → missing
    expect((await store.getObject('back'))?.status).toBe('missing');

    await seedR2([['alice/repo/back', 4]]);
    const res = await reconcileObjects(env.LFS_BUCKET, store, 'alice/repo/');
    expect(res.confirmed).toBe(1);
    expect((await store.getObject('back'))?.status).toBe('present');
  });

  test('skips the missing sweep when markMissing is false (cleared prefix)', async () => {
    const store = env.STORAGE.getByName('alice/repo');
    await store.recordObject('cold', 9, 'verify'); // present, bytes cleared to cold storage

    const res = await reconcileObjects(env.LFS_BUCKET, store, 'alice/repo/', false);
    expect(res.missing).toBe(0);
    expect((await store.getObject('cold'))?.status).toBe('present');
  });

  test('leaves a present row whose bytes exist untouched', async () => {
    const store = env.STORAGE.getByName('alice/repo');
    await store.recordObject('keep', 3, 'verify');
    await seedR2([['alice/repo/keep', 3]]);

    const res = await reconcileObjects(env.LFS_BUCKET, store, 'alice/repo/');
    expect(res.missing).toBe(0);
    expect((await store.getObject('keep'))?.status).toBe('present');
  });

  test('scopes to the given prefix and paginates', async () => {
    const store = env.STORAGE.getByName('alice/repo');
    for (let i = 0; i < 1200; i++) await store.recordObject(`o${i}`, 1, 'upload');
    const entries: [string, number][] = [];
    for (let i = 0; i < 1200; i++) entries.push([`alice/repo/o${i}`, 1]);
    await seedR2(entries);

    const res = await reconcileObjects(env.LFS_BUCKET, store, 'alice/repo/');
    expect(res.confirmed).toBe(1200);
  });
});
