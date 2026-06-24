import { notify, restingAlert } from '@/alerts/lifecycle';
import type { Registry, StorageRow } from '@/db/registry';
import { Repo } from '@/db/repo';
import { Storage } from '@/db/storage';
import { gcConfig } from '@/gc/config';
import { lfsServer } from '@/server/lfs-server';
import { startWorkflow } from '@/workflows/lifecycle';

type RegistryStub = DurableObjectStub<Registry>;

// Lifecycle ops: RPC the LFS server before the REGISTRY write, so a server failure leaves the row
// untouched (retriable). The one `lfs-server` seam for all high-level callers (routes/cron/wf).

// null = REGISTRY refused (already blocked / purged); throws if the server RPC fails. `backup: false`
// skips the cold-storage backup start — used by a direct purge of an unused prefix (archive → purge,
// no backup), where the cold copy is about to be deleted anyway.
export async function archive(
  env: CloudflareBindings,
  registry: RegistryStub,
  prefix: string,
  { backup = true }: { backup?: boolean } = {},
): Promise<StorageRow | null> {
  const [owner, repo] = splitPrefix(prefix);
  await lfsServer(env).blockRepo(owner, repo);
  const row = await registry.block(prefix);
  if (row) {
    await notify(env, owner, repo, 'archived');
    // Cold storage on → back up now instead of next `autoBackup` tick. Best-effort: the block
    // already landed, so a busy/failed start must not fail the archive (autoBackup retries).
    if (backup && gcConfig(env).coldStorage) {
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

// Recompute a prefix's effective block set after a branch confirm/undelete on the git repo
// `gitOwner/gitRepo` (which need not equal the prefix's own segments). Diffs the freshly-computed
// set against the current `deleted` rows, then RPCs the server (authoritative 404 gate) *before*
// the STORAGE status bookkeeping — a server failure leaves object statuses untouched (retriable).
// May block/unblock zero OIDs when references stay live. Returns the applied delta.
export async function recomputeBlocks(
  env: CloudflareBindings,
  gitOwner: string,
  gitRepo: string,
  prefix: string,
): Promise<{ blocked: string[]; unblocked: string[] }> {
  const desired = await Repo.byRepo(env, gitOwner, gitRepo).blockedOidsForPrefix(prefix);
  const store = Storage.byPrefix(env, prefix);
  const current = await store.listOidsByStatus('deleted');
  const desiredSet = new Set(desired);
  const currentSet = new Set(current);
  const toBlock = desired.filter((oid) => !currentSet.has(oid));
  const toUnblock = current.filter((oid) => !desiredSet.has(oid));
  const [owner, repo] = splitPrefix(prefix);
  if (toBlock.length) await lfsServer(env).blockObjects(owner, repo, toBlock);
  if (toUnblock.length) await lfsServer(env).unblockObjects(owner, repo, toUnblock);
  if (toBlock.length) await store.setObjectsStatus(toBlock, 'deleted');
  if (toUnblock.length) await store.setObjectsStatus(toUnblock, 'present');
  return { blocked: toBlock, unblocked: toUnblock };
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

// A prefix's two path segments — the LFS server's repo identity (it canonicalizes them back to the
// prefix via `resolveName`). This is the storage's own key, not a git→storage link traversal.
function splitPrefix(prefix: string): [owner: string, repo: string] {
  const [owner, repo] = prefix.split('/');
  return [owner, repo];
}
