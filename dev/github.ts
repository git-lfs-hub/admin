// Local-dev stand-in for "repos present on GitHub" (no GitHub App key locally). Any
// discovered repo NOT listed here goes `missing` on reconcile. Case-insensitive
// `owner/repo`; empty = everything missing. Editing + save reloads the worker.
// Distinct dev-only name so the deploy bundle check (scripts/assert-no-dev.ts) has a
// future-proof marker that can't collide with a prod symbol.
export const devPresentRepos: string[] = ['acme/webapp', 'acme/mobile', 'acme/docs'];

// Local-dev `.lfsconfig` link graph: maps each present git repo to the storage prefix its committed
// `.lfsconfig` `lfs.url` points at — one prefix per repo, exactly what a default-branch scan yields.
// Stand-in for the GraphQL sweep (no GitHub App key locally); the fixture is fed through the real
// REPO-DO scan path, so the admin UI shows the graph prod would. A present repo absent here has no
// `.lfsconfig` → no link → its prefix reads `unused`. Edit + save to reshape: drop a consumer to
// watch a shared prefix stay `used` until the last one goes, drop both to watch it flip `unused`.
export const devLinks: Record<string, string> = {
  // Two git repos share one storage prefix (one `lfs.url`) — N git repos : 1 storage.
  'acme/webapp': 'acme/shared-lfs',
  'acme/mobile': 'acme/shared-lfs',
  // Git repo points at a differently-named prefix (mismatched `.lfsconfig` path).
  'acme/docs': 'acme/docs-assets',
};
