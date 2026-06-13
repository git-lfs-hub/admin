import type { Registry, StorageRow } from '@/db/registry';
import { gcConfig } from '@/gc/config';
import { startWorkflow } from '@/workflows/lifecycle';

const MAX_PER_TICK = 10; // account-concurrency cap

/** Cron auto-BackUp (cold storage only): start a `BackupWorkflow` for each blocked prefix lacking a
 *  complete cold copy. Non-destructive → no confirmation gate. Runs after `autoArchive` so a
 *  freshly-blocked prefix gets backed up the same tick; gated on the cold-start guard. */
export async function autoBackup(
  env: CloudflareBindings,
  registry: DurableObjectStub<Registry>,
): Promise<StorageRow[]> {
  if (!gcConfig(env).coldStorage) return [];
  const started: StorageRow[] = [];
  for (const r of await registry.listStorage()) {
    if (r.status === 'purged') continue;
    if (!r.archivedAt) continue; // pre-warm of a serving prefix is admin-only
    if (r.clearedAt) continue; // live cleared — nothing to copy
    if (r.backupComplete) continue;
    if (r.activeOp) continue;
    if (started.length >= MAX_PER_TICK) break;
    try {
      await startWorkflow(env, 'backup', { prefix: r.prefix });
      started.push(r);
    } catch (e) {
      console.error(`[auto-backup] failed for ${r.prefix}:`, e);
    }
  }
  return started;
}
