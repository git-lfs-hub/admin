import { scopeFor } from '@/alerts/message';
import { Alerts } from '@/db/alerts';
import type { AlertKind, NotifyKind } from '@/db/alerts-schema';
import { lifecycleState, type LifecycleRow, type LifecycleState } from '@/storage/actions';

// The standing, level-triggered alert a resting prefix warrants (null = nothing to surface).
const RESTING_ALERT: Partial<Record<LifecycleState, NotifyKind>> = {
  unused: 'missing',
  archived: 'archived',
};

export function restingAlert(row: LifecycleRow): NotifyKind | null {
  return RESTING_ALERT[lifecycleState(row)] ?? null;
}

// A prefix has at most one standing notify alert; raising a kind clears the others it supersedes.
// Confirmation kinds (`purge`) are not notify-superseded — their lifecycle is owned by the
// workflow + `clearAlert`.
const CLEARS: Record<NotifyKind, AlertKind[]> = {
  missing: ['reappeared', 'restored', 'archived'],
  archived: ['missing', 'restored'],
  reappeared: ['missing'],
  restored: ['archived'],
};

/** Best-effort: failures are logged, never thrown, so notification can't break the lifecycle
 *  op that triggered it. */
export async function notify(
  env: CloudflareBindings,
  owner: string,
  repo: string,
  kind: NotifyKind,
): Promise<void> {
  const scope = scopeFor(owner, repo);
  try {
    const alerts = Alerts.global(env);
    for (const other of CLEARS[kind]) await alerts.clearAlert(scope, other);
    await alerts.sendNotification({ kind, scope });
  } catch (e) {
    console.error(`[alerts] notify ${kind} failed for ${owner}/${repo}:`, e);
  }
}
