// Local-dev stand-in for "repos present on GitHub" (no GitHub App key locally). Any
// discovered repo NOT listed here goes `missing` on reconcile. Case-insensitive
// `owner/repo`; empty = everything missing. Editing + save reloads the worker.
// Distinct dev-only name so the deploy bundle check (scripts/assert-no-dev.ts) has a
// future-proof marker that can't collide with a prod symbol.
export const devPresentRepos: string[] = ['acme/webapp', 'acme/mobile', 'acme/docs'];

// Local-dev `.lfsconfig` link graph (no GitHub App key → no real scan). Maps each present git repo
// to the storage prefix(es) its `.lfsconfig` points at, so the admin UI shows the real N:N graph
// instead of the same-key 1:1 guess. A present repo absent here falls back to its same-key prefix.
// Edit + save to reshape the graph: drop a consumer to watch a shared prefix stay `used` until the
// last one goes, drop both to watch it flip `unused`.
export const devLinks: Record<string, string[]> = {
  // Two git repos share one storage prefix (one `lfs.url`) — N git repos : 1 storage.
  'acme/webapp': ['acme/shared-lfs'],
  'acme/mobile': ['acme/shared-lfs'],
  // Git repo points at a differently-named prefix (mismatched `.lfsconfig` path).
  'acme/docs': ['acme/docs-assets'],
};
