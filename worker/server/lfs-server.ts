// wrangler types the binding as a bare `Service`, so narrow it to the contract here;
// the shape is enforced on the producer (server `AdminEntrypoint implements LfsServer`).
import type { LfsServer } from "@git-lfs-hub/lib/contracts";

export type { LfsServer };

export function lfsServer(env: CloudflareBindings): LfsServer {
  return env.LFS_SERVER as unknown as LfsServer;
}
