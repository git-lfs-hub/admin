// Dev fixture: git repos "present on GitHub" (no App key locally), fed through real reconcile by
// dev/mock-github.ts under the primary allowed org. `devPresentRepos` is also the assert-no-dev marker.
export const devPresentRepos: string[] = [
  'webapp',
  'mobile-app',
  'marketing-site',
  'marketing-app',
  'legacy',
];

// Each repo's `.lfsconfig` target, as the prefix repo-name (org prepended at scan time). Values are
// repos server/dev/seed.ts seeds R2 under, so links land on real objects; absent → `unused`.
export const devLinks: Record<string, string> = {
  webapp: 'webapp',
  'mobile-app': 'mobile-app',
  // N:1 — two repos share one prefix.
  'marketing-site': 'design-assets',
  'marketing-app': 'design-assets',
  // mismatched name; `archived-svc` is seeded but has no consumer → stays `unused`.
  legacy: 'old-project',
};
