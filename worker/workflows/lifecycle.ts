import type { WorkflowStep } from 'cloudflare:workers';

import type { StorageStatus } from '@/db/registry-schema';
import { Storage } from '@/db/storage';
import type { WorkflowOp } from '@/db/storage-schema';
import { listS3Page, type S3Object } from '@/s3/list';

// Shared scaffolding for the lifecycle workflows (backup / purge / restore).

// op → its Workflow binding name on env. Keeps the op string the single source of truth so call
// sites never repeat the `'purge', env.PURGE_WORKFLOW` pair.
const WORKFLOW_BINDING = {
  backup: 'BACKUP_WORKFLOW',
  clear: 'CLEAR_WORKFLOW',
  restore: 'RESTORE_WORKFLOW',
  purge: 'PURGE_WORKFLOW',
  deleteBackup: 'DELETE_BACKUP_WORKFLOW',
} as const satisfies Record<WorkflowOp, keyof CloudflareBindings>;

// Params accepted by the workflow bound to op O.
type WorkflowParams<O extends WorkflowOp> =
  CloudflareBindings[(typeof WORKFLOW_BINDING)[O]] extends Workflow<infer P> ? P : never;

// Look up the Workflow binding for an op (purge → env.PURGE_WORKFLOW, …). The cast narrows the
// indexed-access type to a concrete `Workflow<P>` so callers' `create`/`get` resolve over generic O.
export function workflowFor<O extends WorkflowOp>(
  env: CloudflareBindings,
  op: O,
): Workflow<WorkflowParams<O>> {
  return env[WORKFLOW_BINDING[op]] as Workflow<WorkflowParams<O>>;
}

// `<op>-<uuid>` — fresh per run so a rerun never collides with a prior (completed) instance.
export function workflowInstanceId(op: string): string {
  return `${op}-${crypto.randomUUID()}`;
}

// Reserve the op on the STORAGE DO (409 if the prefix is busy with a *different* op), then create
// the instance under a fresh `<op>-<uuid>` id (recorded in the `workflows` table). A later
// approve/cancel reads the id back via `Storage.activeInstanceId`, not from the prefix.
export async function startWorkflow<O extends WorkflowOp>(
  env: CloudflareBindings,
  op: O,
  params: WorkflowParams<O>,
): Promise<string> {
  const prefix = (params as { prefix: string }).prefix;
  const store = Storage.byPrefix(env, prefix);
  const id = workflowInstanceId(op);
  await store.beginOp(prefix, id, op);
  await workflowFor(env, op).create({ id, params });
  return id;
}

// Stop the active `op` instance on `prefix` (if any), then close the op so `activeOp` clears — a
// terminated run never reaches its own `finish` step. Resting `status` is left unchanged (nothing
// was deleted). Slack/alert side-effects are the caller's.
export async function terminateWorkflow(
  env: CloudflareBindings,
  op: WorkflowOp,
  prefix: string,
  status: StorageStatus,
): Promise<void> {
  const store = Storage.byPrefix(env, prefix);
  const id = await store.activeInstanceId(op);
  if (!id) return;
  try {
    (await workflowFor(env, op).get(id)).terminate();
  } catch {
    // workflow already finished/terminated — nothing to stop
  }
  await store.endOp(prefix, id, 'terminated', status);
}

// Walk every R2 object page under `{prefix}/`, applying `perPage` to each. List + work share one
// step, so per-object work must be idempotent (backup HEAD-skip, delete naturally).
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
// the walk ANDs them — poll uses the result to decide whether to sleep again.
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

// The cursor pump: run `page(cursor)` inside step `${label}:${n}`, threading the cursor until it's
// undefined. Steps here so each page persists only its cursor, never the key list. Returns the AND of
// every page's readiness (`ready` defaults true).
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
