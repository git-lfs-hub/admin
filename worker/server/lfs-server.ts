// Narrow the LFS_SERVER service binding to the shared cross-worker contract.
// wrangler types the binding as a bare `Service` (no cross-worker method
// inference); the real shape is enforced on the producer (server/src/admin/
// entrypoint.ts `implements LfsServer`).
import type { LfsServer } from "@git-lfs-hub/lib/contracts";

export type { LfsServer };

export function lfsServer(env: CloudflareBindings): LfsServer {
  return env.LFS_SERVER as unknown as LfsServer;
}
