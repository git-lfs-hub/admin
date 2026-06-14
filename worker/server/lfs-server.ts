// wrangler types the binding as a bare `Service`, so narrow it to the contract here;
// the shape is enforced on the producer (server `AdminEntrypoint implements LfsServer`).
import type { LfsServer } from '@git-lfs-hub/lib/contracts';

export type { LfsServer };

// Pure RPC accessor — no logic. The block/unblock/purge RPCs take a repo's two path segments
// (owner, repo) and the server canonicalizes internally via `resolveName`. Deriving owner/repo
// from a prefix is caller logic and lives in `server/operations`. Throws propagate to the caller.
export function lfsServer(env: CloudflareBindings): LfsServer {
  return env.LFS_SERVER as unknown as LfsServer;
}
