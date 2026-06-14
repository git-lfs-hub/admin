import { reset } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, test, expect, afterEach } from 'vitest';

import { discoverRepos } from '@/storage/discovery';

afterEach(async () => {
  await reset();
});

const reg = () => env.REGISTRY.getByName('global');

async function seed(keys: string[]) {
  for (const k of keys) await env.LFS_BUCKET.put(k, 'x');
}

describe('discoverRepos', () => {
  test('discovers owner/repo prefixes from R2', async () => {
    await seed(['alice/one/aaa', 'alice/one/bbb', 'alice/two/ccc', 'bob/three/ddd']);
    const found = await discoverRepos(env.LFS_BUCKET, reg());
    expect([...found].sort()).toEqual(['alice/one', 'alice/two', 'bob/three']);
    const rows = await reg().listStorage();
    expect(rows.map((r) => r.prefix).sort()).toEqual(['alice/one', 'alice/two', 'bob/three']);
  });

  test('is idempotent with existing storage rows (preserves firstSeen)', async () => {
    await seed(['alice/one/aaa']);
    await discoverRepos(env.LFS_BUCKET, reg());
    const first = await reg().getStorage('alice/one');
    await new Promise((r) => setTimeout(r, 1100));
    await discoverRepos(env.LFS_BUCKET, reg());
    const second = await reg().getStorage('alice/one');
    expect(second?.firstSeen).toBe(first?.firstSeen);
    expect(second?.updatedAt).not.toBe(first?.updatedAt);
  });

  test('returns empty array when bucket is empty', async () => {
    const found = await discoverRepos(env.LFS_BUCKET, reg());
    expect(found).toEqual([]);
  });

  test('handles many keys across many repos (pagination path)', async () => {
    const owners = ['o1', 'o2', 'o3'];
    const keys: string[] = [];
    for (const o of owners) {
      for (let i = 0; i < 5; i++) keys.push(`${o}/r${i}/obj`);
    }
    await seed(keys);
    const found = await discoverRepos(env.LFS_BUCKET, reg());
    expect(found.length).toBe(15);
  });

  test('follows R2 list cursor across truncated pages', async () => {
    // Stub bucket: owner listing is truncated across two pages; each owner's
    // repo listing fits one page. Exercises the `truncated` cursor loop.
    const pages: Record<string, { delimitedPrefixes: string[] }[]> = {
      '': [{ delimitedPrefixes: ['alice/'] }, { delimitedPrefixes: ['bob/'] }],
      'alice/': [{ delimitedPrefixes: ['alice/one/'] }],
      'bob/': [{ delimitedPrefixes: ['bob/two/'] }],
    };
    const bucket = {
      list: async ({ prefix, cursor }: { prefix: string; cursor?: string }) => {
        const list = pages[prefix];
        const i = cursor ? Number(cursor) : 0;
        const truncated = i < list.length - 1;
        return {
          ...list[i],
          truncated,
          cursor: truncated ? String(i + 1) : undefined,
        };
      },
    } as unknown as R2Bucket;

    const found = await discoverRepos(bucket, reg());
    expect([...found].sort()).toEqual(['alice/one', 'bob/two']);
  });
});
