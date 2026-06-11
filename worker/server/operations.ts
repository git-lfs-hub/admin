import { notify, restingAlert } from '@/alerts/lifecycle';
import type { Registry, StorageRow } from '@/db/registry';
import { lfsServer } from '@/server/lfs-server';

type RegistryStub = DurableObjectStub<Registry>;

// End-to-end storage-lifecycle ops: each flips the LFS server (RPC) AND the admin REGISTRY for a
// prefix, in RPC-before-write order so a server failure leaves the row untouched (retriable).
// High-level callers (routes, cron, reconcile, the purge workflow) come through here instead of
// touching `lfs-server` directly. Owner/repo is derived from the prefix here (`splitPrefix`) — the
// single seam to replace when repo⇄storage links land.

// Serve-block + mark the row blocked. Returns the row, or null when REGISTRY refused (already
// blocked / purged). Throws if the server RPC fails.
export async function archive(
  env: CloudflareBindings,
  registry: RegistryStub,
  prefix: string,
): Promise<StorageRow | null> {
  const [owner, repo] = splitPrefix(prefix);
  await lfsServer(env).blockRepo(owner, repo);
  const row = await registry.block(prefix);
  if (row) await notify(env, owner, repo, 'archived');
  return row;
}

// Clear the serve-block + mark the row unblocked. Returns the row, or null when it wasn't blocked.
// Throws if the server RPC fails.
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

// Post-purge server cleanup (Locks wipe + server registry → purged). RPC only: the admin REGISTRY
// mark is a separate, durable workflow step. Idempotent.
export function purgeServer(env: CloudflareBindings, prefix: string): Promise<void> {
  const [owner, repo] = splitPrefix(prefix);
  return lfsServer(env).purgeRepo(owner, repo);
}

// The seam: today a prefix is exactly `owner/repo`; replace with a repo⇄storage link lookup.
function splitPrefix(prefix: string): [owner: string, repo: string] {
  const [owner, repo] = prefix.split('/');
  return [owner, repo];
}
