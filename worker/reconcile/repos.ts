import { orgsFromEnv } from '@git-lfs-hub/lib/auth';
import { GithubApi, GithubError, type RepoScan } from '@git-lfs-hub/lib/github';

import { notify, restingAlert } from '@/alerts/lifecycle';
import type {
  Registry,
  StorageRow,
  ReconciliationResult,
  StorageReconciliationResult,
} from '@/db/registry';
import type { OrgStatus } from '@/db/registry-schema';
import { probeOrg, type OrgProbeResult } from '@/github/probeOrg';
import { syncLfsconfigs } from '@/reconcile/lfsconfig';
import { restore } from '@/server/operations';

export type OrgsByStatus = Record<OrgStatus, string[]>;

export type RepoCounts = {
  active: number;
  missing: number;
  reappeared: number; // missing → active (git presence restored)
  unblocked: number; // prefix became used + blocked + clearedAt null → auto-unblocked
  clearedReappeared: number; // prefix became used + blocked + clearedAt set → alert (manual restore)
};

export type ReconcileSummary = {
  orgs: OrgsByStatus;
  repos: RepoCounts;
  fullScan: boolean; // every installed org enumerated cleanly (no transient_error)
};

export async function reconcileRepos(
  env: CloudflareBindings,
  registry: DurableObjectStub<Registry>,
): Promise<ReconcileSummary> {
  const app = await GithubApi.forApp(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);

  const allow = allowedOrgs(env);
  const accounts = (await app.installedOrgs()).filter((a) => allow.has(a.login.toLowerCase()));
  if (accounts.length === 0) return emptySummary();

  const activeRepos = new Set<string>();
  const scans: RepoScan[] = [];
  const orgs: OrgsByStatus = {
    active: [],
    missing: [],
    no_installation: [],
    forbidden: [],
    transient_error: [],
  };

  for (const account of accounts) {
    let probe: OrgProbeResult;
    try {
      probe = await probeOrg(await app.orgApi(account));
    } catch (e) {
      probe = classifyError(e);
    }
    const org = account.login.toLowerCase();
    orgs[probe.status].push(org);
    await registry.upsertOrgStatus(org, probe.status, probe.error ?? null);
    if (probe.status === 'active') {
      for (const k of probe.activeRepos) activeRepos.add(k);
      scans.push(...probe.scans);
    }
  }

  // Uninstall sweep: owners we still track that no longer appear in the install list →
  // `no_installation` (status only — repos stay `active`, storage stays `used`; an admin
  // archives/purges their storage). Skip orgs already marked so the cron doesn't re-warn.
  const installed = new Set(accounts.map((a) => a.login.toLowerCase()));
  for (const row of await registry.listOrgs()) {
    if (installed.has(row.org) || row.status === 'no_installation') continue;
    await registry.upsertOrgStatus(row.org, 'no_installation');
    orgs.no_installation.push(row.org);
  }

  const { git, unblocked, cleared } = await applyReconciliation(
    env,
    registry,
    new Set(orgs.active),
    activeRepos,
  );
  // Isolated so a sweep failure never sinks the presence reconciliation above — it gates auto-purge.
  try {
    await syncLfsconfigs(env, scans);
  } catch (e) {
    console.error('[reconcile] lfsconfig sweep failed:', e);
  }
  warnAnomalies(orgs);

  // `transient_error` = an org's repos couldn't be listed, so this isn't a full scan. Definitive
  // non-active answers (missing/forbidden/no_installation) are real and still count as enumerated.
  return {
    orgs,
    repos: {
      active: activeRepos.size,
      missing: git.missing.length,
      reappeared: git.reappeared.length,
      unblocked,
      clearedReappeared: cleared.length,
    },
    fullScan: orgs.transient_error.length === 0,
  };
}

/** Reconcile git presence, then storage link state, then auto-unblock present-but-blocked
 *  prefixes. Shared with the local-dev fixture path (`dev/reconcileLocal.ts`). */
export async function applyReconciliation(
  env: CloudflareBindings,
  registry: DurableObjectStub<Registry>,
  activeOrgs: Set<string>,
  activeRepos: Set<string>,
): Promise<{
  git: ReconciliationResult;
  storage: StorageReconciliationResult;
  unblocked: number;
  cleared: StorageRow[];
}> {
  const git = await registry.recordReconciliation({ activeOrgs, activeRepos });
  const storage = await registry.reconcileStorage();
  const { unblocked, cleared } = await autoUnblock(env, registry, storage.blockedReused);
  // Alerts track STORAGE state, not git presence (a prefix is `unused` whether its repo was
  // deleted or never tracked). Level-triggered over every non-purged prefix, so anything in an
  // attention state — including before the notifier shipped — is surfaced; ALERTS dedups.
  // Reuse/restore clear via becameUsed/autoUnblock; archived also fires at its action sites.
  for (const r of await registry.listStorage()) {
    const kind = restingAlert(r);
    if (!kind) continue;
    const { owner, repo } = splitPrefix(r.prefix);
    await notify(env, owner, repo, kind);
  }
  for (const r of storage.becameUsed) {
    const { owner, repo } = splitPrefix(r.prefix);
    await notify(env, owner, repo, 'reappeared');
  }
  for (const r of cleared) await notifyClearedReappeared(env, r);
  return { git, storage, unblocked, cleared };
}

/** Apply one webhook repo event onto the same path cron uses: presence flip, then per-prefix
 *  link reconcile + RPC-gated auto-unblock (or cleared-reappearance alert). */
export async function reconcileRepoEvent(
  env: CloudflareBindings,
  registry: DurableObjectStub<Registry>,
  owner: string,
  repo: string,
  present: boolean,
): Promise<void> {
  if (!allowedOrgs(env).has(owner.toLowerCase())) return;
  const res = await registry.applyRepoEvent(owner, repo, present);
  if (!res) return;
  const store = await registry.storageForRepo(owner, repo);
  if (!store) return;
  const storage = await registry.reconcileStoragePrefix(store.prefix);
  const { cleared } = await autoUnblock(env, registry, storage.blockedReused);
  // Storage-centric notifications (same as the cron path), keyed on the prefix's flip — not
  // bare repo presence — so we never alert a prefix that didn't change.
  for (const r of storage.becameUnused) {
    const { owner: o, repo: p } = splitPrefix(r.prefix);
    await notify(env, o, p, 'missing');
  }
  for (const r of storage.becameUsed) {
    const { owner: o, repo: p } = splitPrefix(r.prefix);
    await notify(env, o, p, 'reappeared');
  }
  for (const r of cleared) await notifyClearedReappeared(env, r);
}

/**
 * Prefixes whose git repo is back but still blocked (`archivedAt` set). Unblock RPC before
 * clearing `archivedAt`, so a failure leaves the prefix blocked → next cron retries (still
 * present + blocked). `clearedAt` set (live gone) is NOT auto-unblocked — surfaced for an
 * alert; admin restores via Glacier.
 */
export async function autoUnblock(
  env: CloudflareBindings,
  registry: DurableObjectStub<Registry>,
  blockedReused: StorageRow[],
): Promise<{ unblocked: number; cleared: StorageRow[] }> {
  let unblocked = 0;
  const cleared: StorageRow[] = [];
  for (const r of blockedReused) {
    if (r.clearedAt) {
      cleared.push(r);
      continue;
    }
    try {
      if (await restore(env, registry, r.prefix)) unblocked++;
    } catch (e) {
      console.error(`[reconcile] auto-unblock failed for ${r.prefix}:`, e);
    }
  }
  return { unblocked, cleared };
}

/** Present + blocked + cleared (live gone): notify-only — admin must restore via Glacier. */
async function notifyClearedReappeared(env: CloudflareBindings, r: StorageRow): Promise<void> {
  const { owner, repo } = splitPrefix(r.prefix);
  await notify(env, owner, repo, 'reappeared');
}

/** Orgs this deployment manages (`GITHUB_ORGS`), lowercased. The App may be public, so installs
 *  and webhook events for any other owner are ignored — only configured orgs are tracked. */
export function allowedOrgs(env: CloudflareBindings): Set<string> {
  return new Set(orgsFromEnv(env).map((o) => o.toLowerCase()));
}

function splitPrefix(prefix: string): { owner: string; repo: string } {
  const [owner, repo] = prefix.split('/');
  return { owner, repo };
}

/** Log non-active org anomalies (org-level, not per-repo — repo changes notify via alerts). */
function warnAnomalies(orgs: OrgsByStatus): void {
  for (const status of ['missing', 'no_installation', 'forbidden'] as const) {
    for (const org of orgs[status]) {
      console.warn(`[reconcile] org=${org} status=${status}`);
    }
  }
}

/** Map a thrown probe error (acquisition or listing) to a non-active OrgProbeResult. */
function classifyError(e: unknown): OrgProbeResult {
  if (e instanceof GithubError) {
    if (e.code === 'no_installation' || e.code === 'forbidden' || e.code === 'missing')
      return { status: e.code, error: e.message };
  }
  return { status: 'transient_error', error: e instanceof Error ? e.message : String(e) };
}

function emptySummary(): ReconcileSummary {
  return {
    fullScan: false, // zero installs → nothing enumerated, not a full scan
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
