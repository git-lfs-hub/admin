import { parseLfsConfig } from '@git-lfs-hub/lib/git/lfs';
import type { GithubOrgApi } from '@git-lfs-hub/lib/github';

import type { Repo, LfsConfig } from '@/db/repo';
import { isLocalLfsHost } from '@/lib/lfsEndpoint';

export type ScanOutcome = 'unchanged' | 'missing' | 'ok' | 'parse_error' | 'unreachable';

export type ScanRef = { owner: string; repo: string; branch: string; headSha: string };

/** Scan a branch's committed `.lfsconfig` and record the result on the REPO DO. A single
 *  `getContent` call returns the blob sha *and* bytes together — GitHub's rate limit counts
 *  requests, not bytes, so one call beats a tree-walk + blob fetch. Layer-1 dedup (stored head
 *  unchanged) skips the call entirely; steady state is 0 GitHub calls/tick. A transient error
 *  leaves the branch row untouched (`unreachable`) for retry. `local = 0` blobs are recorded but
 *  feed no `links` — that projection (step 4) reads only `local` rows. */
export async function scanLfsConfig(
  api: GithubOrgApi,
  repo: DurableObjectStub<Repo>,
  env: CloudflareBindings,
  ref: ScanRef,
  force = false,
): Promise<ScanOutcome> {
  // `force` skips the head dedup: the branch state machine may have already advanced the head, so
  // an unchanged head no longer means the `.lfsconfig` is current.
  if (!force && (await headUnchanged(repo, ref))) return 'unchanged'; // layer 1: branch didn't move
  let file: { sha: string; text: string } | null;
  try {
    file = await api.getFile(ref.repo, '.lfsconfig', ref.headSha);
  } catch {
    return 'unreachable';
  }
  return recordScan(repo, env, ref, file);
}

/** Cron-backstop counterpart of `scanLfsConfig`: the GraphQL sweep returns the blob inline, so no
 *  per-repo fetch. `blob` null = absent; `{ text: null }` = unreadable (→ `unreachable`, retry). */
export async function scanLfsConfigInline(
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
  const parse = parseLfsConfig(file.text);
  const blob: LfsConfig = { sha: file.sha, ...parse, local: isLocalLfsHost(parse.host, env) };
  await repo.recordLfsconfig(ref.branch, ref.headSha, blob);
  return blob.status;
}
