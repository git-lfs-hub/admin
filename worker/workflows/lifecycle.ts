import type { WorkflowStep } from 'cloudflare:workers';

import { Storage } from '@/db/storage';
import type { WorkflowOp } from '@/db/storage-schema';
import { listS3Page, type S3Object } from '@/s3/list';
import { workflowInstanceId } from '@/workflows/instanceId';

// Shared scaffolding for the lifecycle workflows (backup / purge / restore). The per-op executors
// hold only what differs (what each page does, the confirmation gate, the finish handoff).

// Reserve the op on the STORAGE DO (409 if the prefix is busy with a *different* op), then create
// the deterministic single-shard instance. The id is reconstructable from `(op, prefix)`, so a later
// approve/cancel can wake the running instance. Every trigger (admin route + cron) comes through here.
export async function startWorkflow<P extends { prefix: string }>(
  env: CloudflareBindings,
  op: WorkflowOp,
  workflow: Workflow<P>,
  params: P,
): Promise<string> {
  const id = workflowInstanceId(op, params.prefix);
  await Storage.byPrefix(env, params.prefix).beginOp(params.prefix, id, op);
  await workflow.create({ id, params });
  return id;
}

// Walk every R2 object page under `{prefix}/`, applying `perPage` to each (copy, delete, …). List +
// work share one step, so per-object work must be idempotent (backup HEAD-skip, delete naturally).
// Used by backup + purge.
export async function walkR2Pages(
  step: WorkflowStep,
  bucket: R2Bucket,
  prefix: string,
  label: string,
  perPage: (objects: R2Object[]) => Promise<void>,
): Promise<void> {
  await walkPages(step, label, async (cursor) => {
    const list = await bucket.list({ prefix: `${prefix}/`, cursor });
    await perPage(list.objects);
    return { cursor: list.truncated ? list.cursor : undefined };
  });
}

// Walk every cold-storage (S3) object page under `{prefix}/`, applying `perPage` to each. Restore
// runs one walk per pass (thaw → poll/sleep → pull), re-listing from the cursor each pass since the
// `step.sleep`s sit between walks. `perPage` may return a per-page readiness bool (default ready);
// the walk returns the AND across pages — poll uses it to decide whether to sleep again.
export function walkS3Pages(
  step: WorkflowStep,
  env: CloudflareBindings,
  prefix: string,
  label: string,
  perPage: (objects: S3Object[]) => Promise<boolean | void>,
): Promise<boolean> {
  return walkPages(step, label, async (cursor) => {
    const list = await listS3Page(env, `${prefix}/`, cursor);
    const ready = (await perPage(list.objects)) ?? true;
    return { cursor: list.cursor, ready };
  });
}

// The cursor pump: run `page(cursor)` inside step `${label}:${n}`, threading the returned cursor
// until it's undefined (exhausted). Owns the stepping so each page persists only its cursor, never
// the key list. Returns the AND of every page's readiness (`ready` defaults true).
async function walkPages(
  step: WorkflowStep,
  label: string,
  page: (cursor: string | undefined) => Promise<{ cursor?: string; ready?: boolean }>,
): Promise<boolean> {
  let cursor: string | undefined;
  let allReady = true;
  let n = 0;
  do {
    const res = await step.do(`${label}:${n}`, () => page(cursor));
    if (res.ready === false) allReady = false;
    cursor = res.cursor;
    n++;
  } while (cursor);
  return allReady;
}
