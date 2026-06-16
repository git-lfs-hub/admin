import type { GithubOrgApi } from '@git-lfs-hub/lib/github';

import type { Repo, LfsconfigParse } from '@/db/repo';
import { parseLfsUrl, isLocalLfsHost } from '@/lib/lfsEndpoint';

export type ScanOutcome = 'unchanged' | 'missing' | 'ok' | 'parse_error' | 'unreachable';

export type ScanRef = { owner: string; name: string; branch: string; headSha: string };

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
  const { owner, name, branch, headSha } = ref;

  const prior = await repo.getBranch(branch);
  if (prior?.headSha === headSha) return 'unchanged'; // layer 1: branch didn't move → no GitHub call

  let file: { sha: string; text: string } | null;
  try {
    file = await fetchLfsconfig(api, owner, name, headSha);
  } catch {
    return 'unreachable';
  }
  if (!file) {
    await repo.recordMissing(branch, headSha);
    return 'missing';
  }

  // Re-parsing an unchanged blob is a cheap regex; `lfsconfigs` dedups by `sha` (no-op insert).
  const blob: LfsconfigParse = { sha: file.sha, ...parseLfsconfig(file.text, env) };
  await repo.recordLfsconfig(branch, headSha, blob);
  return blob.status;
}

/** Fetch the root `.lfsconfig` at a ref in one call (sha + decoded bytes). Null when the file is
 *  absent (404); other errors throw → `unreachable`. */
async function fetchLfsconfig(
  api: GithubOrgApi,
  owner: string,
  repo: string,
  ref: string,
): Promise<{ sha: string; text: string } | null> {
  let data;
  try {
    ({ data } = await api.octokit.rest.repos.getContent({ owner, repo, path: '.lfsconfig', ref }));
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
  if (Array.isArray(data) || data.type !== 'file') return null;
  const text =
    data.encoding === 'base64'
      ? new TextDecoder().decode(
          Uint8Array.from(atob(data.content.replace(/\s/g, '')), (c) => c.charCodeAt(0)),
        )
      : data.content;
  return { sha: data.sha, text };
}

function isNotFound(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { status?: number }).status === 404;
}

function parseLfsconfig(text: string, env: CloudflareBindings): Omit<LfsconfigParse, 'sha'> {
  const url = lfsUrlFromConfig(text);
  const parsed = url ? parseLfsUrl(url) : null;
  const prefix = parsed ? lfsPrefixFromPath(parsed.path) : null;
  if (!parsed || !prefix)
    return { host: parsed?.host ?? '', prefix: '', local: false, status: 'parse_error' };
  return { host: parsed.host, prefix, local: isLocalLfsHost(parsed.host, env), status: 'ok' };
}

/** First `url` under the `[lfs]` section of a git-config (`.lfsconfig`) file. */
function lfsUrlFromConfig(text: string): string | null {
  let inLfs = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      inLfs = /^\[lfs\]$/i.test(line);
    } else if (inLfs) {
      const m = line.match(/^url\s*=\s*(.+)$/i);
      if (m) return m[1].trim();
    }
  }
  return null;
}

/** Storage prefix from an `lfs.url` path: the `owner/repo` after the `/lfs/` route, `.git` and a
 *  trailing `/info/lfs` stripped. Mirrors the server's `resolveName()` candidate construction. */
function lfsPrefixFromPath(path: string): string | null {
  const segs = path.split('/').filter(Boolean);
  if (segs[segs.length - 2] === 'info' && segs[segs.length - 1] === 'lfs') segs.splice(-2);
  if (segs[0] === 'lfs') segs.shift();
  if (segs.length < 2) return null;
  return `${segs[0]}/${segs[1].replace(/\.git$/, '')}`;
}
