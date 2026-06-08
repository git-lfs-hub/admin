import { GithubApi, GithubError } from '@git-lfs-hub/lib/github';

import type {
  Registry,
  StorageRow,
  ReconciliationResult,
  StorageReconciliationResult,
} from '@/db/registry';
import type { OrgStatus } from '@/db/registry-schema';
import { probeOrg, type OrgProbeResult } from '@/github/probeOrg';
import { unblockPrefix } from '@/server/lfs-server';

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
};

export async function reconcileRepos(
  env: CloudflareBindings,
  registry: DurableObjectStub<Registry>,
): Promise<ReconcileSummary> {
  const app = await GithubApi.forApp(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);

  const accounts = await app.installedOrgs();
  if (accounts.length === 0) return emptySummary();

  const activeRepos = new Set<string>();
  const orgs: OrgsByStatus = {
    active: [],
    missing: [],
    no_installation: [],
    forbidden: [],
    transient_error: [],
  };

  for (const account of accounts) {
    const org = account.login.toLowerCase();
    let probe: OrgProbeResult;
    try {
      probe = await probeOrg(await app.orgApi(account));
    } catch (e) {
      probe = classifyError(e);
    }
    orgs[probe.status].push(org);
    await registry.upsertOrgStatus(org, probe.status, probe.error ?? null);
    if (probe.status === 'active') {
      for (const k of probe.activeRepos) activeRepos.add(k);
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
  warnAnomalies(orgs, cleared);

  // Cold-start guard: a `transient_error` org means its repos couldn't be listed, so the
  // link state is unreliable — don't certify the pass. Definitive non-active answers
  // (missing/forbidden/no_installation) are real and don't block certification.
  if (orgs.transient_error.length === 0) await registry.markFullScan();

  return {
    orgs,
    repos: {
      active: activeRepos.size,
      missing: git.missing.length,
      reappeared: git.reappeared.length,
      unblocked,
      clearedReappeared: cleared.length,
    },
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
  const res = await registry.applyRepoEvent(owner, repo, present);
  if (!res) return;
  const store = await registry.storageForRepo(owner, repo);
  if (!store) return;
  const storage = await registry.reconcileStoragePrefix(store.prefix);
  const { cleared } = await autoUnblock(env, registry, storage.blockedReused);
  for (const r of cleared) warnClearedReappeared(r);
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
      await unblockPrefix(env, r.prefix);
      await registry.unblock(r.prefix);
      unblocked++;
    } catch (e) {
      console.error(`[reconcile] auto-unblock failed for ${r.prefix}:`, e);
    }
  }
  return { unblocked, cleared };
}

/** Log reconciliation anomalies: cleared-then-reappeared prefixes and non-active orgs. */
function warnAnomalies(orgs: OrgsByStatus, clearedReappeared: StorageRow[]): void {
  for (const r of clearedReappeared) warnClearedReappeared(r);
  for (const status of ['missing', 'no_installation', 'forbidden'] as const) {
    for (const org of orgs[status]) {
      console.warn(`[reconcile] org=${org} status=${status}`);
    }
  }
}

/** Present + blocked + cleared (live gone): notify-only, admin must restore via Glacier. */
export function warnClearedReappeared(r: StorageRow): void {
  console.warn(
    `[reconcile] blocked+cleared prefix reappeared (manual restore needed): ${r.prefix}`,
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
