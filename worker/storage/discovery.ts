import type { Registry } from '@/db/registry';

/**
 * Scan R2 for `Owner/Repo/` prefixes and upsert each into the REGISTRY `storage` table.
 * Idempotent: existing prefixes get `updated_at` bumped via upsert. The prefix keeps R2's
 * canonical casing (the per-prefix STORAGE DO name); GitHub presence is a separate identity.
 */
export async function discoverRepos(
  bucket: R2Bucket,
  registry: DurableObjectStub<Registry>,
): Promise<string[]> {
  const found: string[] = [];

  for await (const ownerPrefix of listPrefixes(bucket, '')) {
    const owner = ownerPrefix.slice(0, -1);
    /* istanbul ignore next -- defensive: R2 delimited prefixes always have a non-empty owner segment */
    if (!owner) {
      console.warn(`[discovery] skipping empty owner prefix: ${ownerPrefix}`);
      continue;
    }
    for await (const repoPrefix of listPrefixes(bucket, ownerPrefix)) {
      const repo = repoPrefix.slice(ownerPrefix.length, -1);
      /* istanbul ignore next -- defensive: R2 delimited prefixes always have a non-empty repo segment */
      if (!repo) {
        console.warn(`[discovery] skipping empty repo prefix: ${repoPrefix}`);
        continue;
      }
      const prefix = `${owner}/${repo}`;
      await registry.upsertStorage(prefix);
      found.push(prefix);
    }
  }

  return found;
}

async function* listPrefixes(bucket: R2Bucket, prefix: string): AsyncGenerator<string> {
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix, delimiter: '/', cursor });
    for (const p of listed.delimitedPrefixes) yield p;
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}
