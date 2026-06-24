import { Hono, type Context, type Next } from 'hono';

import type { AppEnv } from '@/_env';
import { groupBy } from '@/api/cross-link';
import { Registry } from '@/db/registry';
import { Repo } from '@/db/repo';
import { Storage, type UsageByStatus } from '@/db/storage';
import { gcConfig } from '@/gc/config';
import { branchWillPurgeAt, isScanStale } from '@/gc/deadlines';
import { isLocal } from '@/lib/host';
import { recomputeBlocks } from '@/server/operations';

// Read-only: presence is reconcile's/the webhook's call. Lifecycle actions live on `/api/storage`.
const app = new Hono<AppEnv>()
  .get('/', async (c) => {
    const registry = Registry.global(c.env);
    const [repos, links] = await Promise.all([
      registry.listRepos(),
      registry.listActiveRepoLinks(),
    ]);
    // Real git→prefix cross-link from `links` (a repo can consume N prefixes), not a same-key guess.
    const storageByRepo = groupBy(
      links,
      (l) => `${l.owner}/${l.repo}`,
      (l) => ({
        prefix: l.prefix,
        status: l.status,
        archivedAt: l.archivedAt,
      }),
    );
    const result = repos.map((row) => ({
      ...row,
      storage: storageByRepo.get(`${row.owner}/${row.repo}`) ?? [],
    }));
    return c.json({ repos: result });
  })

  // Per-repo branch drilldown (REPO DO): each branch's `.lfsconfig` prefix + lifecycle, with
  // prefix-level usage (total / blocked) for the local prefixes it links to.
  .get('/:owner/:repo/branches', requireOwnerAdmin, async (c) => {
    const { owner, repo } = c.req.param();
    const gc = gcConfig(c.env);
    const summaries = await Repo.byRepo(c.env, owner, repo).branchSummaries();

    const prefixes = [
      ...new Set(summaries.flatMap((s) => (s.lfsconfig?.local ? [s.lfsconfig.prefix] : []))),
    ];
    const usageByPrefix = new Map(
      await Promise.all(
        prefixes.map(
          async (p) => [p, summarizeUsage(await Storage.byPrefix(c.env, p).usage())] as const,
        ),
      ),
    );

    const branches = summaries.map((s) => ({
      branch: s.branch,
      status: s.status,
      dirty: s.dirty,
      scannedAt: s.scannedAt,
      missingAt: s.missingAt,
      deletedAt: s.deletedAt,
      willPurgeAt: branchWillPurgeAt(s.deletedAt, gc),
      oidCount: s.oidCount,
      lfsconfig: s.lfsconfig,
      prefixUsage: s.lfsconfig?.local ? (usageByPrefix.get(s.lfsconfig.prefix) ?? null) : null,
    }));
    return c.json({ branches });
  })

  // Confirm branch deletion (forfeit references). Gate on a fresh scan, resolve the local prefix,
  // flag `deleted`, then recompute the prefix block set (RPC before STORAGE writes).
  .post('/:owner/:repo/branches/:branch/delete', requireOwnerAdmin, async (c) => {
    const { owner, repo, branch } = c.req.param();
    const repoStub = Repo.byRepo(c.env, owner, repo);
    const cur = await repoStub.getBranch(branch);
    if (!cur) return c.json({ error: 'not_found' }, 404);
    // A `dirty`/stale/never-resolved branch can't yield a trustworthy block set.
    if (cur.dirty || isScanStale(cur.scannedAt, gcConfig(c.env), Date.now()))
      return c.json({ error: 'stale_scan' }, 409);
    const prefix = await repoStub.localPrefixForBranch(branch);
    if (!prefix) return c.json({ error: 'not_local' }, 409);

    const row = await repoStub.markBranchDeleted(branch);
    if (!row) return c.json({ error: 'invalid_state' }, 409);
    try {
      const delta = await recomputeBlocks(c.env, owner, repo, prefix);
      return c.json({ branch: row, ...delta });
    } catch (e) {
      console.error(`[branches] recomputeBlocks failed for ${prefix}:`, e);
      return c.json({ error: 'lfs_server_unavailable' }, 502);
    }
  })

  // Undelete: branch back to `active`/`missing`, then recompute (unblocks OIDs no other deleted
  // branch holds).
  .post('/:owner/:repo/branches/:branch/undelete', requireOwnerAdmin, async (c) => {
    const { owner, repo, branch } = c.req.param();
    const repoStub = Repo.byRepo(c.env, owner, repo);
    const prefix = await repoStub.localPrefixForBranch(branch);
    const row = await repoStub.undeleteBranch(branch);
    if (!row) return c.json({ error: 'invalid_state' }, 409);
    if (prefix) {
      try {
        await recomputeBlocks(c.env, owner, repo, prefix);
      } catch (e) {
        console.error(`[branches] recomputeBlocks failed for ${prefix}:`, e);
        return c.json({ error: 'lfs_server_unavailable' }, 502);
      }
    }
    return c.json({ branch: row });
  });

// Prefix usage for the drilldown: `total` is every object's bytes/count, `blocked` is the
// soft-deleted (forfeited) subset.
function summarizeUsage(usage: UsageByStatus) {
  const total = { count: 0, size: 0 };
  for (const { count, size } of Object.values(usage)) {
    total.count += count;
    total.size += size;
  }
  return { total, blocked: usage.deleted };
}

// The auth gate admits an admin of *any* configured org, so re-check the caller against this
// `:owner`. Local dev (`api` unset) has full access. Mirrors `api/storage.ts`.
async function requireOwnerAdmin(c: Context<AppEnv>, next: Next) {
  if (isLocal(c)) return next();
  if ((await c.var.api.orgRole(c.req.param('owner')!)) !== 'admin')
    return c.json({ error: 'forbidden' }, 403);
  await next();
}

export default app;
