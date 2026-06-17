// Classify a committed `.lfsconfig` `lfs.url` as pointing at *this* deployment (`local`) or an
// external hub. Not `lib/host.ts` — that's the dev request bypass; this compares an arbitrary
// `lfs.url` host against `env.LFS.server`.

/** True iff `host` (a parsed `lfs.url` host) is this deployment's LFS server (`env.LFS.server`).
 *  Normalizes case + default ports and ignores scheme, so `https://Host`, `http://host:80`, and
 *  `host` all compare equal. */
export function isLocalLfsHost(host: string, env: CloudflareBindings): boolean {
  const self = normalizeHost(env.LFS.server);
  return self !== null && self === normalizeHost(host);
}

/** Reduce a host or full URL to `URL.host` (default ports dropped, lowercased). Null if neither
 *  parses. */
function normalizeHost(value: string): string | null {
  const withScheme = value.includes('://') ? value : `https://${value}`;
  try {
    return new URL(withScheme).host.toLowerCase();
  } catch {
    return null;
  }
}
