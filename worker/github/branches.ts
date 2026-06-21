import { lfsPatterns, matchesLfs, parseLfsPointer } from '@git-lfs-hub/lib/git/lfs';
import type { GithubOrgApi, TreeEntry } from '@git-lfs-hub/lib/github';

import type { PointerRow, RefPath, Repo } from '@/db/repo';

// Commit-driven branch tip tracking. `ref_paths` = the LFS-pointer subset of a branch's tip tree.
// Webhook pushes drive cheap deltas; a full tree read happens only with no safe baseline (first
// sight, force push, dirty repair) — and `tree_sha`/sibling/blob-sha caches make even that cheap.

/** GitHub's `compare` file cap; a result at/over it can't be trusted complete. */
const COMPARE_FILE_CAP = 300;

export type BranchTip = { headSha: string; treeSha: string };

export type BranchPushEvent = {
  repo: string;
  branch: string;
  before: string;
  after: string;
  treeSha: string | null;
  forced: boolean;
  addedModified: string[];
  removed: string[];
};

export type ApplyOutcome = 'resolved' | 'copied' | 'unchanged' | 'delta' | 'dirty' | 'noop';

/** Lazily-built installation API — only invoked when a tier actually needs a GitHub call, so a
 *  sequential push that changed no pointer blob stays 0-call (token exchange included). */
export type GetApi = () => Promise<GithubOrgApi>;

/** Drive one webhook push through the tip state machine, cheapest tier first. */
export async function applyPushEvent(
  getApi: GetApi,
  repo: DurableObjectStub<Repo>,
  push: BranchPushEvent,
): Promise<ApplyOutcome> {
  const prior = await repo.getBranch(push.branch);

  // No safe baseline → full resolve at the tip: first sight, never resolved, dirty, or branch
  // creation (`before` all-zeros — a recreated branch reappears here, `setTip` flips it active).
  if (!prior || !prior.scannedAt || prior.dirty || isCreate(push.before)) {
    if (!push.treeSha) return markDirty(repo, push);
    return resolveBranch(await getApi(), repo, push.branch, {
      headSha: push.after,
      treeSha: push.treeSha,
    });
  }

  const gitattrTouched =
    push.addedModified.includes('.gitattributes') || push.removed.includes('.gitattributes');

  // Sequential forward: webhook diff is the exact delta.
  if (push.before === prior.headSha && !push.forced && !gitattrTouched && push.treeSha)
    return applySequential(getApi, repo, prior.gitattrSha, push);

  // Forward gap (missed middle webhook): one `compare`, applied like a sequential delta.
  if (push.before !== prior.headSha && !push.forced)
    return applyCompareGap(await getApi(), repo, prior.gitattrSha, push);

  // Diverged / force push / `.gitattributes` touched → baseline unknown, defer to resolve.
  return markDirty(repo, push);
}

/** Sequential delta from the webhook file list. Touches GitHub only if a *matching* pointer path
 *  changed; a removes-only (or no-LFS) push advances the tip with 0 calls. */
async function applySequential(
  getApi: GetApi,
  repo: DurableObjectStub<Repo>,
  gitattrSha: string | null,
  push: BranchPushEvent,
): Promise<ApplyOutcome> {
  const patterns = lfsPatterns(await repo.getGitattributes(gitattrSha ?? ''));
  const candidates = push.addedModified.filter((p) => matchesLfs(p, patterns));
  const tip = { headSha: push.after, treeSha: push.treeSha!, gitattrSha };
  if (candidates.length === 0) {
    await repo.applyRefPathsDelta(push.branch, [], push.removed);
    await repo.setTip(push.branch, tip);
    return 'delta';
  }
  return applyDelta(
    await getApi(),
    repo,
    push.branch,
    push.repo,
    push.after,
    candidates,
    push.removed,
    tip,
  );
}

/** Full resolve (first sight / dirty repair): replace `ref_paths` from the tip tree.
 *  `tree_sha` no-op and sibling-copy short-circuits cost 0 GitHub calls. */
export async function resolveBranch(
  api: GithubOrgApi,
  repo: DurableObjectStub<Repo>,
  branch: string,
  tip: BranchTip,
): Promise<ApplyOutcome> {
  const prior = await repo.getBranch(branch);

  // Already reflects this tree → just clear `dirty`.
  if (prior?.treeSha === tip.treeSha) {
    await repo.setTip(branch, { ...tip, gitattrSha: prior.gitattrSha });
    return 'unchanged';
  }

  // A clean sibling at the same tree holds the answer → copy it.
  const sibling = await repo.cleanBranchAtTree(tip.treeSha, branch);
  if (sibling) {
    const sib = await repo.getBranch(sibling);
    await repo.copyRefPaths(sibling, branch);
    await repo.setTip(branch, { ...tip, gitattrSha: sib?.gitattrSha ?? null });
    return 'copied';
  }

  try {
    const { entries, gitattrSha } = await readTip(api, repo, branch, tip.treeSha);
    await repo.replaceRefPaths(branch, entries);
    await repo.setTip(branch, { ...tip, gitattrSha });
    return 'resolved';
  } catch {
    // Partial / rate-limited read — never replace from an incomplete tree. Leave dirty for retry.
    await markDirty(repo, { branch, after: tip.headSha });
    return 'dirty';
  }
}

/** Read the tip tree and resolve its LFS-pointer `ref_paths` (blob/gitattributes caches first). */
async function readTip(
  api: GithubOrgApi,
  repo: DurableObjectStub<Repo>,
  branch: string,
  treeSha: string,
): Promise<{ entries: RefPath[]; gitattrSha: string | null }> {
  const blobs = await api.listBlobs(branch, treeSha);
  const gitattr = blobs.find((b) => b.path === '.gitattributes') ?? null;
  const content = gitattr ? await loadGitattributes(api, repo, branch, gitattr.sha) : null;
  const patterns = lfsPatterns(content);
  const matched = blobs.filter((b) => matchesLfs(b.path, patterns));
  const pointers = await resolvePointers(api, repo, branch, matched);
  const entries: RefPath[] = [];
  for (const b of matched) {
    const oid = pointers.get(b.sha)?.oid;
    if (oid) entries.push({ oid, path: b.path });
  }
  return { entries, gitattrSha: gitattr?.sha ?? null };
}

/** `.gitattributes` content via the cache, fetching+caching on a miss. */
async function loadGitattributes(
  api: GithubOrgApi,
  repo: DurableObjectStub<Repo>,
  branch: string,
  sha: string,
): Promise<string | null> {
  const hit = await repo.getGitattributes(sha);
  if (hit !== null) return hit;
  const fetched = (await api.getBlobs(branch, [sha])).get(sha)?.text ?? null;
  if (fetched !== null) await repo.putGitattributes(sha, fetched);
  return fetched;
}

/** A git blob larger than this can't be an LFS pointer (canonical pointer is ~130 B). */
const POINTER_MAX_BYTES = 1024;

/** Pointer parses for the matched blobs: cache hits first, then batch-fetch+parse the misses, but
 *  skip blobs whose git size is too large to be a pointer (negative-cached, never fetched). Caches
 *  results (positive + negative); returned map holds only positive (`oid`) entries. */
async function resolvePointers(
  api: GithubOrgApi,
  repo: DurableObjectStub<Repo>,
  branch: string,
  matched: TreeEntry[],
): Promise<Map<string, PointerRow>> {
  const shas = [...new Set(matched.map((b) => b.sha))];
  const sizeBySha = new Map(matched.map((b) => [b.sha, b.size]));
  const cached = await repo.getPointers(shas);
  const out = new Map<string, PointerRow>();
  for (const [sha, row] of cached) if (row.oid) out.set(sha, row);

  // Prune oversized misses before any fetch: a matched path that's too big is a real (non-migrated)
  // file, not a pointer → cache negative, skip the blob fetch.
  const misses = shas.filter((s) => !cached.has(s));
  const oversized = misses.filter((s) => (sizeBySha.get(s) ?? 0) > POINTER_MAX_BYTES);
  if (oversized.length > 0)
    await repo.putPointers(oversized.map((sha) => ({ sha, oid: null, size: null })));

  const toFetch = misses.filter((s) => (sizeBySha.get(s) ?? 0) <= POINTER_MAX_BYTES);
  if (toFetch.length === 0) return out;
  const fetched = await api.getBlobs(branch, toFetch);
  const fresh: PointerRow[] = toFetch.map((sha) => {
    const text = fetched.get(sha)?.text;
    const p = text != null ? parseLfsPointer(text) : null;
    return { sha, oid: p?.oid ?? null, size: p?.size ?? null };
  });
  await repo.putPointers(fresh);
  for (const row of fresh) if (row.oid) out.set(row.sha, row);
  return out;
}

type TipSet = { headSha: string; treeSha: string; gitattrSha: string | null };

/** Fetch the given matching pointer paths at `after`, upsert/remove `ref_paths`, advance the tip. */
async function applyDelta(
  api: GithubOrgApi,
  repo: DurableObjectStub<Repo>,
  branch: string,
  repoName: string,
  after: string,
  candidates: string[],
  removed: string[],
  tip: TipSet,
): Promise<ApplyOutcome> {
  const upserts: RefPath[] = [];
  const removePaths = [...removed];
  for (const path of candidates) {
    const file = await api.getFile(repoName, path, after);
    if (!file) {
      removePaths.push(path);
      continue;
    }
    const pointer = await pointerFor(repo, file.sha, file.text);
    if (pointer) upserts.push({ oid: pointer, path });
    else removePaths.push(path);
  }
  await repo.applyRefPathsDelta(branch, upserts, removePaths);
  await repo.setTip(branch, tip);
  return 'delta';
}

/** A blob's pointer oid (cache first, parse+cache on miss), or null if it isn't a pointer. */
async function pointerFor(
  repo: DurableObjectStub<Repo>,
  sha: string,
  text: string,
): Promise<string | null> {
  const hit = (await repo.getPointers([sha])).get(sha);
  if (hit) return hit.oid;
  const p = parseLfsPointer(text);
  await repo.putPointers([{ sha, oid: p?.oid ?? null, size: p?.size ?? null }]);
  return p?.oid ?? null;
}

async function applyCompareGap(
  api: GithubOrgApi,
  repo: DurableObjectStub<Repo>,
  gitattrSha: string | null,
  push: BranchPushEvent,
): Promise<ApplyOutcome> {
  const cmp = await api.compare(push.repo, push.before, push.after);
  if (cmp.status === 'behind' || cmp.status === 'identical') return 'noop'; // stale webhook
  const renamed = cmp.files.some((f) => f.status === 'renamed');
  const trustworthy =
    cmp.status === 'ahead' && cmp.files.length < COMPARE_FILE_CAP && !renamed && push.treeSha;
  const gitattrTouched = cmp.files.some((f) => f.filename === '.gitattributes');
  if (!trustworthy || gitattrTouched) return markDirty(repo, push);

  const patterns = lfsPatterns(await repo.getGitattributes(gitattrSha ?? ''));
  const removed = cmp.files.filter((f) => f.status === 'removed').map((f) => f.filename);
  const candidates = cmp.files
    .filter((f) => f.status !== 'removed' && matchesLfs(f.filename, patterns))
    .map((f) => f.filename);
  return applyDelta(api, repo, push.branch, push.repo, push.after, candidates, removed, {
    headSha: push.after,
    treeSha: push.treeSha!,
    gitattrSha,
  });
}

/** An all-zeros (or empty) `before` is a branch-creation push — no prior commit to diff against. */
function isCreate(before: string): boolean {
  return before === '' || /^0+$/.test(before);
}

async function markDirty(
  repo: DurableObjectStub<Repo>,
  push: { branch: string; after: string },
): Promise<ApplyOutcome> {
  await repo.markDirty(push.branch, push.after);
  return 'dirty';
}
