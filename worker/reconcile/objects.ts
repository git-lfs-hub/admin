import type { Storage, ObjectReconciliationResult } from '@/db/storage';

export type ReconcileObjectsResult = ObjectReconciliationResult & {
  present: number; // oids the scan listed in R2 (live bytes)
  missing: number; // present/pending in index, absent from the full scan → marked missing
};

/** Reconcile a prefix's object index against R2, page by page: confirm/resize listed oids, then
 *  sweep any indexed row the scan never saw to `missing` (bytes gone). `markMissing` is false for a
 *  cleared prefix — Clear deleted the live copy on purpose, so an empty scan is expected. */
export async function reconcileObjects(
  bucket: R2Bucket,
  index: DurableObjectStub<Storage>,
  prefix: string,
  markMissing = true,
): Promise<ReconcileObjectsResult> {
  const total = { added: 0, confirmed: 0, resized: 0 };
  const seen = new Set<string>();
  for await (const objects of listPages(bucket, prefix)) {
    const page: Record<string, number> = {};
    for (const o of objects) {
      const oid = o.key.slice(prefix.length);
      page[oid] = o.size;
      seen.add(oid);
    }
    const r = await index.recordReconciliation(page);
    total.added += r.added;
    total.confirmed += r.confirmed;
    total.resized += r.resized;
  }
  const missing = markMissing ? await index.sweepMissing([...seen]) : 0;
  return { ...total, present: seen.size, missing };
}

async function* listPages(bucket: R2Bucket, prefix: string): AsyncGenerator<R2Object[]> {
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix, cursor });
    if (listed.objects.length > 0) yield listed.objects;
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}
