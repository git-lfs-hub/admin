import type { Repos } from "@/db/repos";

/**
 * Scan R2 for `owner/repo/` prefixes and upsert each into the REPOS DO.
 * Idempotent: existing repos get `updated_at` bumped via upsert.
 */
export async function discoverRepos(
  bucket: R2Bucket,
  repos: DurableObjectStub<Repos>,
): Promise<{ owner: string; repo: string }[]> {
  const found: { owner: string; repo: string }[] = [];

  for await (const ownerPrefix of listPrefixes(bucket, "")) {
    const owner = ownerPrefix.slice(0, -1);
    if (!owner) continue;
    for await (const repoPrefix of listPrefixes(bucket, ownerPrefix)) {
      const repo = repoPrefix.slice(ownerPrefix.length, -1);
      if (!repo) continue;
      await repos.upsert(owner, repo);
      found.push({ owner, repo });
    }
  }

  return found;
}

async function* listPrefixes(
  bucket: R2Bucket,
  prefix: string,
): AsyncGenerator<string> {
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix, delimiter: "/", cursor });
    for (const p of listed.delimitedPrefixes) yield p;
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}
