import { notify, restingAlert } from '@/alerts/lifecycle';
import type { Registry, StorageRow } from '@/db/registry';
import { gcConfig } from '@/gc/config';
import { lfsServer } from '@/server/lfs-server';
import { startWorkflow } from '@/workflows/lifecycle';

type RegistryStub = DurableObjectStub<Registry>;

// Lifecycle ops: RPC the LFS server before the REGISTRY write, so a server failure leaves the row
// untouched (retriable). The one `lfs-server` seam for all high-level callers (routes/cron/wf).

// null = REGISTRY refused (already blocked / purged); throws if the server RPC fails.
export async function archive(
  env: CloudflareBindings,
  registry: RegistryStub,
  prefix: string,
): Promise<StorageRow | null> {
  const [owner, repo] = splitPrefix(prefix);
  await lfsServer(env).blockRepo(owner, repo);
  const row = await registry.block(prefix);
  if (row) {
    await notify(env, owner, repo, 'archived');
    // Cold storage on → back up now instead of next `autoBackup` tick. Best-effort: the block
    // already landed, so a busy/failed start must not fail the archive (autoBackup retries).
    if (gcConfig(env).coldStorage) {
      try {
        await startWorkflow(env, 'backup', { prefix });
      } catch (e) {
        console.error(`[archive] backup start failed for ${prefix}:`, e);
      }
    }
  }
  return row;
}

// null when it wasn't blocked; throws if the server RPC fails.
export async function restore(
  env: CloudflareBindings,
  registry: RegistryStub,
  prefix: string,
): Promise<StorageRow | null> {
  const [owner, repo] = splitPrefix(prefix);
  await lfsServer(env).unblockRepo(owner, repo);
  const row = await registry.unblock(prefix);
  // Unblocking doesn't bring the repo back: if it's still gone the prefix's resting state is
  // `missing` (serving hasn't resumed), so report that, not `restored`.
  if (row) await notify(env, owner, repo, restingAlert(row) ?? 'restored');
  return row;
}

// Post-purge server cleanup (Locks wipe + server registry → purged). RPC only — the admin REGISTRY
// mark is a separate durable workflow step. Idempotent.
export function purgeServer(env: CloudflareBindings, prefix: string): Promise<void> {
  const [owner, repo] = splitPrefix(prefix);
  return lfsServer(env).purgeRepo(owner, repo);
}

// RPC-only unblock for the cold-restore workflow — the REGISTRY write (`endRestore`) is a separate
// durable step, so RPC failure retries without leaving the row inconsistent. Mirrors `purgeServer`.
export function unblockServer(env: CloudflareBindings, prefix: string): Promise<void> {
  const [owner, repo] = splitPrefix(prefix);
  return lfsServer(env).unblockRepo(owner, repo);
}

// The seam: today a prefix is exactly `owner/repo`; replace with a repo⇄storage link lookup.
function splitPrefix(prefix: string): [owner: string, repo: string] {
  const [owner, repo] = prefix.split('/');
  return [owner, repo];
}
