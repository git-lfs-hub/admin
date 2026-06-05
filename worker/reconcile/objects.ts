import type { RepoIndex, ObjectReconciliationResult } from "@/db/repo-index";

export type ReconcileObjectsResult = ObjectReconciliationResult;

/**
 * Reconcile a repo's object index against storage. Streams the repo's `prefix`
 * one list page at a time, reconciling each page's `oid -> size` against the
 * index DO (confirm `pending` -> `present`, correct sizes) without buffering the
 * full listing. Counts are accumulated across pages.
 */
export async function reconcileObjects(
  bucket: R2Bucket,
  index: DurableObjectStub<RepoIndex>,
  prefix: string,
): Promise<ReconcileObjectsResult> {
  const total: ReconcileObjectsResult = { added: 0, confirmed: 0, resized: 0 };
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix, cursor });
    if (listed.objects.length > 0) {
      const page: Record<string, number> = {};
      for (const o of listed.objects) page[o.key.slice(prefix.length)] = o.size;
      const r = await index.recordReconciliation(page);
      total.added += r.added;
      total.confirmed += r.confirmed;
      total.resized += r.resized;
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return total;
}
