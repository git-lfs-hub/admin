// Build-time flag, replaced with a literal by each bundler's `define`:
//   wrangler deploy (prod)         → false  → the @dev import is DCE'd out of the bundle
//   vite dev / vitest-pool-workers → true   → local fixture reconcile is available
declare const __DEV__: boolean;

// Optional secrets: Slack delivery (SLACK_BOT_TOKEN) and the interactions callback
// (SLACK_SIGNING_SECRET) both no-op when unset, so they're left out of wrangler's
// `secrets.required` and declared optional here instead of being generated as `string`.
interface OptionalSlackSecrets {
  SLACK_BOT_TOKEN?: string;
  SLACK_SIGNING_SECRET?: string;
}
// Worker bindings (Hono `c.env`) and the `cloudflare:workers` test `env` are sibling
// interfaces, so both need the optional fields.
interface CloudflareBindings extends OptionalSlackSecrets {}
declare namespace Cloudflare {
  interface Env extends OptionalSlackSecrets {}
}
