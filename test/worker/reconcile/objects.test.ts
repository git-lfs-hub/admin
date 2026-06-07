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
    const repo = env.REPO.getByName('alice/repo');
    await repo.recordObject('oid1', 10, 'upload'); // pending
    await seedR2([['alice/repo/oid1', 10]]);

    const res = await reconcileObjects(env.LFS_BUCKET, repo, 'alice/repo/');
    expect(res.confirmed).toBe(1);
    expect((await repo.getObject('oid1'))?.status).toBe('present');
  });

  test('populates a mismatched size from R2 truth', async () => {
    const repo = env.REPO.getByName('alice/repo');
    await repo.recordObject('oid1', 999, 'download'); // present, wrong size
    await seedR2([['alice/repo/oid1', 42]]);

    const res = await reconcileObjects(env.LFS_BUCKET, repo, 'alice/repo/');
    expect(res.resized).toBe(1);
    expect((await repo.getObject('oid1'))?.size).toBe(42);
  });

  test('adds storage objects missing from the index', async () => {
    const repo = env.REPO.getByName('alice/repo');
    await seedR2([['alice/repo/orphan', 8]]);

    const res = await reconcileObjects(env.LFS_BUCKET, repo, 'alice/repo/');
    expect(res.added).toBe(1);
    const row = await repo.getObject('orphan');
    expect(row?.size).toBe(8);
    expect(row?.status).toBe('present');
    expect(row?.source).toBe('storage_scan');
  });

  test('leaves indexed objects absent from storage untouched', async () => {
    const repo = env.REPO.getByName('alice/repo');
    await repo.recordObject('gone', 5, 'upload'); // pending, not in storage

    const res = await reconcileObjects(env.LFS_BUCKET, repo, 'alice/repo/');
    expect(res).toEqual({ added: 0, confirmed: 0, resized: 0 });
    expect((await repo.getObject('gone'))?.status).toBe('pending');
  });

  test('scopes to the given prefix and paginates', async () => {
    const repo = env.REPO.getByName('alice/repo');
    for (let i = 0; i < 1200; i++) await repo.recordObject(`o${i}`, 1, 'upload');
    const entries: [string, number][] = [];
    for (let i = 0; i < 1200; i++) entries.push([`alice/repo/o${i}`, 1]);
    await seedR2(entries);

    const res = await reconcileObjects(env.LFS_BUCKET, repo, 'alice/repo/');
    expect(res.confirmed).toBe(1200);
  });
});
