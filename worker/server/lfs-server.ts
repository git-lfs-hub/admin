// wrangler types the binding as a bare `Service`, so narrow it to the contract here;
// the shape is enforced on the producer (server `AdminEntrypoint implements LfsServer`).
import type { LfsServer } from '@git-lfs-hub/lib/contracts';

export type { LfsServer };

export function lfsServer(env: CloudflareBindings): LfsServer {
  return env.LFS_SERVER as unknown as LfsServer;
}

// The block/unblock RPC takes a prefix's two URL-path segments; the server canonicalizes
// internally via `resolveName`. Throws propagate to the caller (RPC-before-write contract).
export function blockPrefix(env: CloudflareBindings, prefix: string): Promise<void> {
  const [owner, repo] = prefix.split('/');
  return lfsServer(env).blockRepo(owner, repo);
}

export function unblockPrefix(env: CloudflareBindings, prefix: string): Promise<void> {
  const [owner, repo] = prefix.split('/');
  return lfsServer(env).unblockRepo(owner, repo);
}
