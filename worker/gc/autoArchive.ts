import type { Registry, StorageRow } from '@/db/registry';
import { gcConfig } from '@/gc/config';
import { isoAddDays } from '@/lib/time';
import { archive } from '@/server/operations';

/** Cron: block `unused` prefixes past their grace window (`unusedAt + autoArchiveDays`).
 *  Status untouched (block is orthogonal). RPC before the DB write, so a failure retries
 *  next tick. Caller gates on the cold-start guard (`reconcileAll`). */
export async function autoArchive(
  env: CloudflareBindings,
  registry: DurableObjectStub<Registry>,
): Promise<StorageRow[]> {
  const now = Date.now();
  const archived: StorageRow[] = [];
  for (const r of await registry.listStorageByStatus('unused')) {
    if (r.archivedAt || !r.unusedAt) continue;
    if (Date.parse(isoAddDays(r.unusedAt, gcConfig(env).autoArchiveDays)) > now) continue;
    try {
      const row = await archive(env, registry, r.prefix);
      if (row) archived.push(row);
    } catch (e) {
      console.error(`[auto-archive] failed for ${r.prefix}:`, e);
    }
  }
  return archived;
}
