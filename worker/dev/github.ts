// -----------------------------------------------------------------------------
// Local-dev GitHub-presence fixture.
//
// In prod, reconciliation lists each org on GitHub; repos absent from the listing
// go `missing`. There is no GitHub App key locally, so dev stands in this list:
// every repo discovered in R2 whose canonical `owner/repo` is NOT listed here is
// treated as deleted-from-GitHub and marked `missing` (then archivable — B3/B4).
//
// Edit this list and save: the worker reloads and re-runs reconciliation on the
// next request. Leave it empty to send every discovered repo `missing`. Matching is
// case-insensitive against the lowercased `owner/repo`.
// -----------------------------------------------------------------------------
export const presentRepos: string[] = ['acme/webapp'];
