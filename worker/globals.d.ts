// Build-time flag, replaced with a literal by each bundler's `define`:
//   wrangler deploy (prod)         → false  → the @dev import is DCE'd out of the bundle
//   vite dev / vitest-pool-workers → true   → local fixture reconcile is available
declare const __DEV__: boolean;
