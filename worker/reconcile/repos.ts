import { GithubApi, GithubError } from '@git-lfs-hub/lib/github';

import type { Repos, RepoRow, ReconciliationResult } from '@/db/repos';
import type { OrgStatus } from '@/db/repos-schema';
import { probeOrg, type OrgProbeResult } from '@/github/probeOrg';
import { lfsServer } from '@/server/lfs-server';

export type OrgsByStatus = Record<OrgStatus, string[]>;

export type RepoCounts = {
  active: number;
  missing: number;
  reappeared: number; // missing → active (presence restored)
  unblocked: number; // present + blocked + clearedAt null → auto-unblocked
  clearedReappeared: number; // present + blocked + clearedAt set → alert (manual restore)
};

export type ReconcileSummary = {
  orgs: OrgsByStatus;
  repos: RepoCounts;
};

export async function reconcileRepos(
  env: CloudflareBindings,
  repos: DurableObjectStub<Repos>,
): Promise<ReconcileSummary> {
  const owners = await repos.listOwners();
  if (owners.length === 0) return emptySummary();

  const app = await GithubApi.forApp(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);

  const activeRepos = new Set<string>();
  const orgs: OrgsByStatus = {
    active: [],
    missing: [],
    no_installation: [],
    forbidden: [],
    transient_error: [],
  };

  for (const org of owners) {
    let probe: OrgProbeResult;
    try {
      probe = await probeOrg(await app.orgApi(org));
    } catch (e) {
      probe = classifyError(e);
    }
    orgs[probe.status].push(org);
    await repos.upsertOrgStatus(org, probe.status, probe.error ?? null);
    if (probe.status === 'active') {
      for (const k of probe.activeRepos) activeRepos.add(k);
    }
  }

  const { result, unblocked, cleared } = await applyReconciliation(
    env,
    repos,
    new Set(orgs.active),
    activeRepos,
  );
  warnAnomalies(orgs, cleared);

  return {
    orgs,
    repos: {
      active: activeRepos.size,
      missing: result.missing.length,
      reappeared: result.reappeared.length,
      unblocked,
      clearedReappeared: cleared.length,
    },
  };
}

/** DO flips presence, then the worker auto-unblocks present-but-blocked rows.
 *  Shared with the local-dev fixture path (`dev/reconcileLocal.ts`). */
export async function applyReconciliation(
  env: CloudflareBindings,
  repos: DurableObjectStub<Repos>,
  activeOrgs: Set<string>,
  activeRepos: Set<string>,
): Promise<{ result: ReconciliationResult; unblocked: number; cleared: RepoRow[] }> {
  const result = await repos.recordReconciliation({ activeOrgs, activeRepos });
  const { unblocked, cleared } = await autoUnblock(env, repos, result.blockedPresent);
  return { result, unblocked, cleared };
}

/**
 * Apply one webhook repo event onto the same path cron uses: DO presence flip, then RPC-gated
 * auto-unblock (or cleared-reappearance alert) for a present+blocked row — the per-repo
 * `recordReconciliation` + `autoUnblock`.
 */
export async function reconcileRepoEvent(
  env: CloudflareBindings,
  repos: DurableObjectStub<Repos>,
  owner: string,
  repo: string,
  present: boolean,
): Promise<void> {
  const res = await repos.applyRepoEvent(owner, repo, present);
  if (!res?.row.archivedAt) return;
  const { cleared } = await autoUnblock(env, repos, [res.row]);
  for (const r of cleared) warnClearedReappeared(r);
}

/**
 * Repos back on GitHub but still blocked. Unblock RPC before clearing `archivedAt`, so a
 * failure leaves the row blocked → next cron retries (still present + blocked). `clearedAt`
 * set (live gone) is NOT auto-unblocked — surfaced for an alert; admin restores via Glacier.
 */
export async function autoUnblock(
  env: CloudflareBindings,
  repos: DurableObjectStub<Repos>,
  blockedPresent: RepoRow[],
): Promise<{ unblocked: number; cleared: RepoRow[] }> {
  const server = lfsServer(env);
  let unblocked = 0;
  const cleared: RepoRow[] = [];
  for (const r of blockedPresent) {
    if (r.clearedAt) {
      cleared.push(r);
      continue;
    }
    try {
      await server.unblockRepo(r.owner, r.repo);
      await repos.unblock(r.owner, r.repo);
      unblocked++;
    } catch (e) {
      console.error(`[reconcile] auto-unblock failed for ${r.name}:`, e);
    }
  }
  return { unblocked, cleared };
}

/** Log reconciliation anomalies: cleared-then-reappeared repos and non-active orgs. */
function warnAnomalies(orgs: OrgsByStatus, clearedReappeared: RepoRow[]): void {
  for (const r of clearedReappeared) warnClearedReappeared(r);
  for (const status of ['missing', 'no_installation', 'forbidden'] as const) {
    for (const org of orgs[status]) {
      console.warn(`[reconcile] org=${org} status=${status}`);
    }
  }
}

/** Present + blocked + cleared (live gone): notify-only, admin must restore via Glacier. */
export function warnClearedReappeared(r: RepoRow): void {
  console.warn(
    `[reconcile] blocked+cleared repo reappeared (manual restore needed): ${r.owner}/${r.repo}`,
  );
}

/** Map a thrown probe error (acquisition or listing) to a non-active OrgProbeResult. */
function classifyError(e: unknown): OrgProbeResult {
  if (e instanceof GithubError) {
    if (e.code === 'no_installation') return { status: 'no_installation', error: e.message };
    if (e.code === 'forbidden') return { status: 'forbidden', error: e.message };
    if (e.code === 'missing') return { status: 'missing', error: e.message };
    return { status: 'transient_error', error: e.message };
  }
  return { status: 'transient_error', error: e instanceof Error ? e.message : String(e) };
}

function emptySummary(): ReconcileSummary {
  return {
    orgs: {
      active: [],
      missing: [],
      no_installation: [],
      forbidden: [],
      transient_error: [],
    },
    repos: {
      active: 0,
      missing: 0,
      reappeared: 0,
      unblocked: 0,
      clearedReappeared: 0,
    },
  };
}
