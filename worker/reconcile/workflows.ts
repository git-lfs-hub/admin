import { type WorkflowInstanceStatus } from 'cloudflare:workers';

import type { Registry } from '@/db/registry';
import { Storage } from '@/db/storage';
import type { WorkflowOp } from '@/db/storage-schema';
import { workflowFor } from '@/workflows/lifecycle';

// Engine states a stuck instance rests in but can never leave on its own. A live run reads
// queued/running/paused/waiting/waitingForPause; `complete` closes itself via its own finish step.
const DEAD: ReadonlySet<WorkflowInstanceStatus> = new Set(['errored', 'terminated', 'unknown']);

// Backstop for `LifecycleWorkflow.run`: an instance killed outside its catch (evicted, OOM) leaves
// `activeOp` set with no one left to clear it.
export async function reconcileWorkflows(
  env: CloudflareBindings,
  registry: DurableObjectStub<Registry>,
): Promise<void> {
  for (const row of await registry.listStorage()) {
    if (!row.activeOp) continue;
    const op = row.activeOp as WorkflowOp;
    const store = Storage.byPrefix(env, row.prefix);
    const id = await store.activeInstanceId(op);
    // Flagged busy but the DO holds no open op row — a stale denormalized flag; just clear it.
    if (!id) {
      await registry.setActiveOp(row.prefix, null);
      continue;
    }
    const state = await instanceState(env, op, id);
    if (!DEAD.has(state)) continue;
    // DEAD ⊆ {errored, terminated, unknown}; `unknown` isn't a WorkflowStatus, so fold it to errored.
    await store.endOp(
      row.prefix,
      id,
      state === 'terminated' ? 'terminated' : 'errored',
      row.status,
    );
    console.warn(`[reconcile] swept stuck ${op} on ${row.prefix} (instance ${state})`);
  }
}

async function instanceState(
  env: CloudflareBindings,
  op: WorkflowOp,
  id: string,
): Promise<WorkflowInstanceStatus> {
  try {
    return (await (await workflowFor(env, op).get(id)).status()).status;
  } catch {
    return 'unknown';
  }
}
