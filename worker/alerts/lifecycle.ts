import { scopeFor } from '@/alerts/message';
import { Alerts } from '@/db/alerts';
import type { AlertKind } from '@/db/alerts-schema';

// A prefix has at most one standing alert (its current attention state). Raising a kind
// clears the others it supersedes — e.g. archiving an unused prefix clears its `missing`,
// reuse clears `missing`, restore clears `archived`.
const CLEARS: Record<AlertKind, AlertKind[]> = {
  missing: ['reappeared', 'restored'],
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
  kind: AlertKind,
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
