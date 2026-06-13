import type { Registry, StorageRow } from '@/db/registry';
import { autoGC } from '@/gc/autoGC';

/** Cron auto-Purge: start a gated `PurgeWorkflow` for each blocked prefix past its retention. Cold
 *  storage uses `retentionDays.cold` (the workflow drops both live R2 and the cold copy); no-cold
 *  uses `retentionDays.live`. */
export function autoPurge(
  env: CloudflareBindings,
  registry: DurableObjectStub<Registry>,
): Promise<StorageRow[]> {
  return autoGC(env, registry, 'purge');
}
