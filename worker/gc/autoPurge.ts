import { scopeFor } from '@/alerts/message';
import { Alerts } from '@/db/alerts';
import type { Registry, StorageRow } from '@/db/registry';
import { Storage } from '@/db/storage';
import { gcConfig } from '@/gc/config';
import { isoAddDays } from '@/lib/time';
import { startPurge } from '@/workflows/purge';

const MAX_PER_TICK = 10; // account-concurrency cap

/** Cron auto-Purge (no-cold path): start a gated `PurgeWorkflow` for each blocked prefix past its
 *  live retention (`archivedAt + liveStorageRetentionDays`). Cron has no intent, so the gate is
 *  wait-only (`triggeredBy: 'auto'` — never proceeds at a deadline). Reappeared prefixes get any
 *  in-flight purge terminated instead. Caller gates on the cold-start guard (`reconcileAll`). */
export async function autoPurge(
  env: CloudflareBindings,
  registry: DurableObjectStub<Registry>,
): Promise<StorageRow[]> {
  if (gcConfig(env).coldStorage) return []; // cold storage purges via S3, not the live-only path
  const now = Date.now();
  const retentionDays = gcConfig(env).liveStorageRetentionDays;
  const started: StorageRow[] = [];
  for (const r of await registry.listStorage()) {
    if (r.status === 'purged') continue;
    // Reappeared (reconcile cleared `archivedAt`, or git repo `active` again): terminate any
    // in-flight purge, then skip.
    if (!r.archivedAt || (await registry.storageInUse(r.prefix))) {
      if (r.activeOp === 'purge') await terminatePurge(env, r);
      continue;
    }
    if (r.activeOp) continue; // op already running
    if (Date.parse(isoAddDays(r.archivedAt, retentionDays)) > now) continue;
    if (started.length >= MAX_PER_TICK) break;
    try {
      const [owner, repo] = r.prefix.split('/');
      await startPurge(env, {
        prefix: r.prefix,
        scope: scopeFor(owner, repo),
        triggeredBy: 'auto',
      });
      started.push(r);
    } catch (e) {
      console.error(`[auto-purge] failed for ${r.prefix}:`, e);
    }
  }
  return started;
}

/** Stop a no-longer-eligible purge: terminate the instance, close the op (resting status unchanged —
 *  nothing was deleted), drop the stale purge confirmation. */
async function terminatePurge(env: CloudflareBindings, r: StorageRow): Promise<void> {
  const store = Storage.byPrefix(env, r.prefix);
  const id = await store.activeInstanceId('purge');
  if (id) {
    try {
      (await env.PURGE_WORKFLOW.get(id)).terminate();
    } catch {
      // already finished/terminated
    }
    await store.endOp(r.prefix, id, 'terminated', r.status);
  }
  const [owner, repo] = r.prefix.split('/');
  await Alerts.global(env).clearAlert(scopeFor(owner, repo), 'purge');
}
