import { reset } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, test, expect, afterEach } from 'vitest';

afterEach(async () => {
  await reset();
});

describe('R2 binding (LFS_BUCKET)', () => {
  test('put stores an object', async () => {
    await env.LFS_BUCKET.put('alice/repo/abc', 'hello');
    const obj = await env.LFS_BUCKET.head('alice/repo/abc');
    expect(obj).not.toBeNull();
    expect(obj?.size).toBe(5);
  });

  test('head returns null for missing key', async () => {
    const obj = await env.LFS_BUCKET.head('missing');
    expect(obj).toBeNull();
  });

  test('list returns stored keys', async () => {
    await env.LFS_BUCKET.put('org/repo/aaa', '1');
    await env.LFS_BUCKET.put('org/repo/bbb', '2');
    const result = await env.LFS_BUCKET.list({ prefix: 'org/repo/' });
    expect(result.objects.map((o) => o.key).sort()).toEqual(['org/repo/aaa', 'org/repo/bbb']);
  });
});

describe('Durable Object binding (REPOS)', () => {
  test('REPOS namespace exists and can create stub', () => {
    const id = env.REPOS.idFromName('global');
    const stub = env.REPOS.get(id);
    expect(stub).toBeDefined();
  });
});
