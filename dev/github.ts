// Local-dev stand-in for "repos present on GitHub" (no GitHub App key locally). Any
// discovered repo NOT listed here goes `missing` on reconcile. Case-insensitive
// `owner/repo`; empty = everything missing. Editing + save reloads the worker.
// Distinct dev-only name so the deploy bundle check (scripts/assert-no-dev.ts) has a
// future-proof marker that can't collide with a prod symbol.
export const devPresentRepos: string[] = ['acme/webapp'];
