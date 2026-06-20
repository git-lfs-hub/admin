import { gitConfigFirstValue } from '@git-lfs-hub/lib/git/config';
import type { GithubOrgApi } from '@git-lfs-hub/lib/github';

import type { Repo, LfsconfigParse } from '@/db/repo';
import { isLocalLfsHost } from '@/lib/lfsEndpoint';

export type ScanOutcome = 'unchanged' | 'missing' | 'ok' | 'parse_error' | 'unreachable';

export type ScanRef = { owner: string; repo: string; branch: string; headSha: string };

/** Scan a branch's committed `.lfsconfig` and record the result on the REPO DO. A single
 *  `getContent` call returns the blob sha *and* bytes together — GitHub's rate limit counts
 *  requests, not bytes, so one call beats a tree-walk + blob fetch. Layer-1 dedup (stored head
 *  unchanged) skips the call entirely; steady state is 0 GitHub calls/tick. A transient error
 *  leaves the branch row untouched (`unreachable`) for retry. `local = 0` blobs are recorded but
 *  feed no `links` — that projection (step 4) reads only `local` rows. */
export async function scanLfsconfig(
  api: GithubOrgApi,
  repo: DurableObjectStub<Repo>,
  env: CloudflareBindings,
  ref: ScanRef,
): Promise<ScanOutcome> {
  if (await headUnchanged(repo, ref)) return 'unchanged'; // layer 1: branch didn't move → no call
  let file: { sha: string; text: string } | null;
  try {
    file = await api.getFile(ref.repo, '.lfsconfig', ref.headSha);
  } catch {
    return 'unreachable';
  }
  return recordScan(repo, env, ref, file);
}

/** Cron-backstop counterpart of `scanLfsconfig`: the GraphQL sweep returns the blob inline, so no
 *  per-repo fetch. `blob` null = absent; `{ text: null }` = unreadable (→ `unreachable`, retry). */
export async function scanLfsconfigInline(
  repo: DurableObjectStub<Repo>,
  env: CloudflareBindings,
  ref: ScanRef,
  blob: { oid: string; text: string | null } | null,
): Promise<ScanOutcome> {
  if (await headUnchanged(repo, ref)) return 'unchanged'; // layer 1: branch didn't move
  if (!blob) return recordScan(repo, env, ref, null);
  if (blob.text === null) return 'unreachable'; // unreadable inline → leave for the webhook
  return recordScan(repo, env, ref, { sha: blob.oid, text: blob.text });
}

/** Layer-1 dedup: has this branch's head not moved since the last recorded scan? */
async function headUnchanged(repo: DurableObjectStub<Repo>, ref: ScanRef): Promise<boolean> {
  const prior = await repo.getBranch(ref.branch);
  return prior?.headSha === ref.headSha;
}

/** Persist a scan result given the branch's `.lfsconfig` bytes (or null when absent). Re-parsing
 *  an unchanged blob is a cheap regex; `lfsconfigs` dedups by `sha` (no-op insert). */
async function recordScan(
  repo: DurableObjectStub<Repo>,
  env: CloudflareBindings,
  ref: ScanRef,
  file: { sha: string; text: string } | null,
): Promise<ScanOutcome> {
  if (!file) {
    await repo.recordMissing(ref.branch, ref.headSha);
    return 'missing';
  }
  const blob: LfsconfigParse = { sha: file.sha, ...parseLfsconfig(file.text, env) };
  await repo.recordLfsconfig(ref.branch, ref.headSha, blob);
  return blob.status;
}

function parseLfsconfig(text: string, env: CloudflareBindings): Omit<LfsconfigParse, 'sha'> {
  const url = gitConfigFirstValue(text, 'lfs', 'url');
  const parsed = url ? parseLfsUrl(url) : null;
  const prefix = parsed ? lfsPrefixFromPath(parsed.path) : null;
  if (!parsed || !prefix)
    return { host: parsed?.host ?? '', prefix: '', local: false, status: 'parse_error' };
  return { host: parsed.host, prefix, local: isLocalLfsHost(parsed.host, env), status: 'ok' };
}

/** Parse an `lfs.url` into its normalized host (`host[:non-default-port]`, lowercased) and path.
 *  Null for a non-`http(s)` or unparseable URL. */
export function parseLfsUrl(url: string): { host: string; path: string } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  return { host: u.host, path: u.pathname };
}

/** Storage prefix from an `lfs.url` path: the `owner/repo` after the `/lfs/` route, `.git`
 *  stripped. Mirrors the server's `resolveName()` candidate construction. */
function lfsPrefixFromPath(path: string): string | null {
  const segs = path.split('/').filter(Boolean);
  if (segs[0] === 'lfs') segs.shift();
  if (segs.length < 2) return null;
  return `${segs[0]}/${segs[1].replace(/\.git$/, '')}`;
}
