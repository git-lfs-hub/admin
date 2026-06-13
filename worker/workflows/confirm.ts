import type { WorkflowSleepDuration, WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';

import { scopeLabel } from '@/alerts/message';
import { Alerts } from '@/db/alerts';
import type { ConfirmKind, Decision } from '@/db/alerts-schema';
import { Registry } from '@/db/registry';
import { Storage } from '@/db/storage';
import { gcConfig } from '@/gc/config';
import { workflowFor } from '@/workflows/lifecycle';

// Workflow-side confirmation gate, kind-agnostic (purge, clear, etc): the wait loop
// (`runConfirmation`) + the gate decision (`readConfirmGate`).

export type ConfirmCtx = {
  env: CloudflareBindings;
  scope: string; // alert scope: storage:lc(owner/repo)
  prefix: string; // storage row key (canonical OwnerCase/RepoCase)
  kind: ConfirmKind;
  // Admin-initiated proceeds at the deadline (intent expressed); cron ('auto') waits — never proceeds.
  triggeredBy: 'admin' | 'auto';
};

// Terminally aborts the workflow at the gate (cancel hold / ineligible) — never retried.
export class ConfirmAborted extends NonRetryableError {}

// Deliver, then loop on `waitForEvent`:
// - approve → proceed;
// - cancel/ineligible → throw;
// - deadline (admin only) → proceed.
export async function runConfirmation(step: WorkflowStep, ctx: ConfirmCtx): Promise<void> {
  const { kind } = ctx;
  await step.do(`confirm:${kind}:deliver`, async () => {
    await Alerts.global(ctx.env).sendConfirmation({ kind, scope: ctx.scope });
  });

  for (;;) {
    let timedOut = false;
    try {
      await step.waitForEvent(`confirm:${kind}:wait`, {
        type: `alert_${kind}`,
        timeout: `${gcConfig(ctx.env).confirmDays} days` as WorkflowSleepDuration,
      });
    } catch (e) {
      if (!isWaitTimeout(e)) throw e;
      timedOut = true;
    }
    const outcome = await step.do(`confirm:${kind}:gate`, () => readConfirmGate(ctx));
    if (outcome === 'terminate')
      throw new ConfirmAborted(`${kind} cancelled or no longer eligible`);
    if (outcome === 'proceed') return;
    if (timedOut && ctx.triggeredBy === 'admin') return; // admin intent → proceed at deadline
    // 'wait': stale/duplicate event, no decision yet — block again.
  }
}

export type GateOutcome = 'proceed' | 'terminate' | 'wait';

// `terminate` wins so a stale approval can't act on a repo that came back or was already purged.
export async function readConfirmGate(ctx: ConfirmCtx): Promise<GateOutcome> {
  const alert = await Alerts.global(ctx.env).getAlert(ctx.scope, ctx.kind);
  if (!alert || alert.decision === 'cancel') return 'terminate';

  const row = await Registry.global(ctx.env).getStorage(ctx.prefix);
  const eligible = row != null && row.status !== 'purged' && row.archivedAt != null;
  if (!eligible) return 'terminate';

  return alert.decision === 'approve' ? 'proceed' : 'wait';
}

// Wake the waiting confirmation instance after an approve/cancel so it acts now instead of at the
// next gate re-check. Best-effort: if the instance is gone the gate re-reads the decision on its
// timeout. Dispatches to the per-kind workflow binding (one event type per kind).
export async function wakeConfirmation(
  env: CloudflareBindings,
  scope: string,
  kind: ConfirmKind,
  decision: Decision,
  by: string,
): Promise<void> {
  const [owner, repo] = scopeLabel(scope).split('/');
  const row = await Registry.global(env).storageForRepo(owner, repo);
  if (!row) return;
  const id = await Storage.byPrefix(env, row.prefix).activeInstanceId(kind);
  if (!id) return;
  try {
    const instance = await workflowFor(env, kind).get(id);
    await instance.sendEvent({ type: `alert_${kind}`, payload: { decision, by } });
  } catch {
    // instance already finished/terminated — nothing to wake
  }
}

// `step.waitForEvent` *rejects* when its timeout elapses (rather than returning a flag).
// Heuristic — confirm the real error shape against the live Workflows runtime.
function isWaitTimeout(e: unknown): boolean {
  return e instanceof Error && (e.name === 'TimeoutError' || /timed?\s*out/i.test(e.message));
}
