import { notify } from '@/alerts/lifecycle';
import type { Registry, StorageRow } from '@/db/registry';
import { isoAddDays } from '@/lib/time';
import { blockPrefix } from '@/server/lfs-server';

/** Cron: block `unused` prefixes past their grace window (`unusedAt + autoArchiveDays`).
 *  Status untouched (block is orthogonal). RPC before the DB write, so a failure retries
 *  next tick. */
export async function autoArchive(
  env: CloudflareBindings,
  registry: DurableObjectStub<Registry>,
): Promise<StorageRow[]> {
  // Cold-start guard: until one trustworthy full pass certifies the link state, a stale/failed
  // probe could read every prefix as `unused` and archive live repos.
  if (!(await registry.getLastFullScanAt())) return [];
  const now = Date.now();
  const archived: StorageRow[] = [];
  for (const r of await registry.listStorageByStatus('unused')) {
    if (r.archivedAt || !r.unusedAt) continue;
    if (Date.parse(isoAddDays(r.unusedAt, env.GC.autoArchiveDays)) > now) continue;
    try {
      await blockPrefix(env, r.prefix);
      const row = await registry.block(r.prefix);
      if (row) {
        archived.push(row);
        const [owner, repo] = r.prefix.split('/');
        await notify(env, owner, repo, 'archived');
      }
    } catch (e) {
      console.error(`[auto-archive] failed for ${r.prefix}:`, e);
    }
  }
  return archived;
}
