import type { Repos } from "@/db/repos";
import type { OrgStatus } from "@/db/_repos-schema";
import { GithubApi, GithubError } from "@git-lfs-hub/lib/github";
import { probeOrg, type OrgProbeResult } from "@/github/probeOrg";

export type OrgsByStatus = Record<OrgStatus, string[]>;

export type RepoCounts = {
  active: number;
  missing: number;
  missingReappeared: number;
  deletedReappeared: number;
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
    const probe = await probeOrgSafe(app, org);
    orgs[probe.status].push(org);
    await repos.upsertOrgStatus(org, probe.status, probe.error ?? null);
    if (probe.status === "active") {
      for (const k of probe.activeRepos) activeRepos.add(k);
    }
  }

  const result = await repos.recordReconciliation({
    activeOrgs: new Set(orgs.active),
    activeRepos,
  });

  for (const r of result.deletedReappeared) {
    console.warn(`[reconcile] deleted repo reappeared: ${r.owner}/${r.repo}`);
  }
  for (const status of ["missing", "no_installation", "forbidden"] as const) {
    for (const org of orgs[status]) {
      console.warn(`[reconcile] org=${org} status=${status}`);
    }
  }

  return {
    orgs,
    repos: {
      active: activeRepos.size,
      missing: result.missing.length,
      missingReappeared: result.missingReappeared.length,
      deletedReappeared: result.deletedReappeared.length,
    },
  };
}

async function probeOrgSafe(app: GithubApi, org: string): Promise<OrgProbeResult> {
  try {
    const orgApi = await app.orgApi(org);
    return await probeOrg(orgApi);
  } catch (e) {
    if (e instanceof GithubError) {
      if (e.code === "no_installation") return { status: "no_installation", error: e.message };
      if (e.code === "forbidden") return { status: "forbidden", error: e.message };
      if (e.code === "missing") return { status: "missing", error: e.message };
      return { status: "transient_error", error: e.message };
    }
    return {
      status: "transient_error",
      error: e instanceof Error ? e.message : String(e),
    };
  }
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
      deletedReappeared: 0,
    },
  };
}
