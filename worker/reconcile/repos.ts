import type { Repos, RepoRow } from "@/db/repos";
import type { OrgStatus } from "@/db/repos-schema";
import { GithubApi, GithubError } from "@git-lfs-hub/lib/github";
import { probeOrg, type OrgProbeResult } from "@/github/probeOrg";
import { lfsServer } from "@/server/lfs-server";

export type OrgsByStatus = Record<OrgStatus, string[]>;

export type RepoCounts = {
  active: number;
  missing: number;
  missingReappeared: number;
  archivedReappearedLive: number;
  archivedReappearedCleared: number;
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

  const app = await GithubApi.forApp(
    env.GITHUB_APP_ID,
    env.GITHUB_APP_PRIVATE_KEY,
  );

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
    if (probe.status === "active") {
      for (const k of probe.activeRepos) activeRepos.add(k);
    }
  }

  const result = await repos.recordReconciliation({activeOrgs: new Set(orgs.active), activeRepos});
  const reappeared = await restoreReappeared(env, repos, result);
  warnAnomalies(orgs, reappeared.cleared);

  return {
    orgs,
    repos: {
      active: activeRepos.size,
      missing: result.missing.length,
      missingReappeared: result.missingReappeared.length,
      archivedReappearedLive: reappeared.live,
      archivedReappearedCleared: reappeared.cleared.length,
    },
  };
}

/**
 * Resume serving for repos that reappeared on GitHub (recordReconciliation already
 * flipped `missing` rows to `active`; `archived` rows are left untouched here).
 * `unblockRepo` must succeed before the status flips, so an RPC failure leaves the
 * row archived/blocked for the next cron to retry. `archived` + `clearedAt` set (live
 * cleared, cold path) does not auto-restore — returned for an alert (B2).
 */
async function restoreReappeared(
  env: CloudflareBindings,
  repos: DurableObjectStub<Repos>,
  result: { missingReappeared: RepoRow[]; archivedReappeared: RepoRow[] },
): Promise<{ live: number; cleared: RepoRow[] }> {
  const server = lfsServer(env);
  let live = 0;
  const cleared: RepoRow[] = [];
  // Missing repos are never blocked; unblock defensively (idempotent).
  for (const r of result.missingReappeared) {
    try {
      await server.unblockRepo(r.owner, r.repo);
    } catch (e) {
      console.error(`[reconcile] unblock failed for ${r.name}:`, e);
    }
  }
  for (const r of result.archivedReappeared) {
    if (r.clearedAt) {
      cleared.push(r);
      continue;
    }
    try {
      await server.unblockRepo(r.owner, r.repo);
      await repos.markActive(r.owner, r.repo);
      live++;
    } catch (e) {
      console.error(`[reconcile] auto-restore failed for ${r.name}:`, e);
    }
  }
  return { live, cleared };
}

/** Log reconciliation anomalies: cleared-then-reappeared repos and non-active orgs. */
function warnAnomalies(orgs: OrgsByStatus, archivedReappearedCleared: RepoRow[]): void {
  for (const r of archivedReappearedCleared) {
    console.warn(`[reconcile] archived repo reappeared after clear (manual restore needed): ${r.owner}/${r.repo}`);
  }
  for (const status of ["missing", "no_installation", "forbidden"] as const) {
    for (const org of orgs[status]) {
      console.warn(`[reconcile] org=${org} status=${status}`);
    }
  }
}

/** Map a thrown probe error (acquisition or listing) to a non-active OrgProbeResult. */
function classifyError(e: unknown): OrgProbeResult {
  if (e instanceof GithubError) {
    if (e.code === "no_installation") return { status: "no_installation", error: e.message };
    if (e.code === "forbidden") return { status: "forbidden", error: e.message };
    if (e.code === "missing") return { status: "missing", error: e.message };
    return { status: "transient_error", error: e.message };
  }
  return { status: "transient_error", error: e instanceof Error ? e.message : String(e) };
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
      missingReappeared: 0,
      archivedReappearedLive: 0,
      archivedReappearedCleared: 0,
    },
  };
}
