import { reset } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, test, expect, afterEach } from 'vitest';

import { reconcileAll } from '@/reconcile/index';

afterEach(async () => {
  await reset();
});

const reg = () => env.REGISTRY.getByName('global');

async function seedR2(entries: [string, number][]) {
  for (const [k, size] of entries) await env.LFS_BUCKET.put(k, 'x'.repeat(size));
}

describe('reconcileAll', () => {
  test('creates a storage row and populates the object index for every discovered prefix', async () => {
    await seedR2([
      ['acme/a/o1', 1],
      ['acme/a/o2', 2],
      ['acme/b/o1', 3],
      ['acme/b/o2', 4],
      ['acme/b/o3', 5],
      ['acme/c/o1', 6],
    ]);

    await reconcileAll(env, true);

    // R2 discovery finds every pushed prefix. The local dev fixture also seeds its `.lfsconfig`
    // link-graph prefixes (acme/shared-lfs, acme/docs-assets), so assert containment, not equality.
    const rows = await reg().listStorage();
    expect(rows.map((r) => r.prefix)).toEqual(
      expect.arrayContaining(['acme/a', 'acme/b', 'acme/c']),
    );

    for (const [prefix, count] of [
      ['acme/a', 2],
      ['acme/b', 3],
      ['acme/c', 1],
    ] as const) {
      const usage = await env.STORAGE.getByName(prefix).usage();
      expect(usage.present.count).toBe(count);
    }
  });
});
