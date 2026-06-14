import type { Registry, StorageRow } from '@/db/registry';
import { autoGC } from '@/gc/autoGC';
import { gcConfig } from '@/gc/config';

/** Cron auto-Clear (cold storage only): start a gated `ClearWorkflow` for each blocked prefix with a
 *  complete cold copy past its clear window (`archivedAt + autoDays.clear`). */
export async function autoClear(
  env: CloudflareBindings,
  registry: DurableObjectStub<Registry>,
): Promise<StorageRow[]> {
  if (!gcConfig(env).coldStorage) return []; // clear only makes sense with a cold copy to fall back on
  // Skip: live already cleared, or clearing before a complete cold copy lands (would lose data).
  return autoGC(env, registry, 'clear', (r) => r.clearedAt != null || !r.backupComplete);
}
