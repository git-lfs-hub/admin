import { scopeForPrefix } from '@/alerts/message';
import { Alerts } from '@/db/alerts';
import type { Registry, StorageRow } from '@/db/registry';
import { gcConfig } from '@/gc/config';
import { dueAt, isDue } from '@/gc/deadlines';
import { startWorkflow, terminateWorkflow } from '@/workflows/lifecycle';

const MAX_PER_TICK = 10; // account-concurrency cap

// A confirmation-gated cron (auto-Clear / auto-Purge). Both walk every blocked prefix and start a
// wait-only gated workflow (`triggeredBy: 'auto'` — never proceeds at a deadline) once it's past
// `dueAt`; a prefix that reappeared (reconcile cleared `archivedAt`, or the git repo went `active`
// again) gets any in-flight instance terminated instead. Caller gates on the cold-start guard.
// `skip`: pre-due skip beyond the shared status/op guards (e.g. clear needs a complete, uncleared copy).
export async function autoGC(
  env: CloudflareBindings,
  registry: DurableObjectStub<Registry>,
  op: 'clear' | 'purge',
  skip?: (row: StorageRow) => boolean,
): Promise<StorageRow[]> {
  const gc = gcConfig(env);
  const now = Date.now();
  const started: StorageRow[] = [];
  for (const r of await registry.listStorage()) {
    if (r.status === 'purged') continue;
    if (!r.archivedAt || (await registry.storageInUse(r.prefix))) {
      if (r.activeOp === op) await terminate(env, op, r);
      continue;
    }
    if (skip?.(r)) continue;
    if (r.activeOp) continue; // op already running
    if (!isDue(dueAt[op](r, gc), now)) continue;
    if (started.length >= MAX_PER_TICK) break;
    try {
      await startWorkflow(env, op, {
        prefix: r.prefix,
        scope: scopeForPrefix(r.prefix),
        triggeredBy: 'auto',
      });
      started.push(r);
    } catch (e) {
      console.error(`[auto-${op}] failed for ${r.prefix}:`, e);
    }
  }
  return started;
}

// Stop a no-longer-eligible instance: terminate it, close the op (resting status unchanged —
// nothing was deleted), drop the stale confirmation.
async function terminate(
  env: CloudflareBindings,
  op: 'clear' | 'purge',
  r: StorageRow,
): Promise<void> {
  await terminateWorkflow(env, op, r.prefix, r.status);
  await Alerts.global(env).clearAlert(scopeForPrefix(r.prefix), op);
}
