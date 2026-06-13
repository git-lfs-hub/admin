import type { WorkflowSleepDuration, WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';

import { Alerts } from '@/db/alerts';
import type { ConfirmKind } from '@/db/alerts-schema';
import { Registry } from '@/db/registry';

// Workflow-side confirmation gate, kind-agnostic (purge, clear, etc): the wait loop
// (`runConfirmation`) + the gate decision (`readConfirmGate`).

export type ConfirmCtx = {
  env: CloudflareBindings;
  scope: string; // alert scope: storage:lc(owner/repo)
  prefix: string; // storage row key (canonical OwnerCase/RepoCase)
  kind: ConfirmKind;
  // Admin-initiated: proceed at the deadline (intent expressed). Cron-triggered: false — wait.
  proceedOnTimeout: boolean;
  timeout: string; // e.g. `${env.GC.purgeConfirmDays} days`
};

// Terminally aborts the workflow at the gate (cancel hold / ineligible) — never retried.
export class ConfirmAborted extends NonRetryableError {}

// Deliver, then loop on `waitForEvent`: approve → proceed; cancel/ineligible → throw; deadline
// (admin only) → proceed.
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
        timeout: ctx.timeout as WorkflowSleepDuration,
      });
    } catch (e) {
      if (!isWaitTimeout(e)) throw e;
      timedOut = true;
    }
    const outcome = await step.do(`confirm:${kind}:gate`, () => readConfirmGate(ctx));
    if (outcome === 'terminate')
      throw new ConfirmAborted(`${kind} cancelled or no longer eligible`);
    if (outcome === 'proceed') return;
    if (timedOut && ctx.proceedOnTimeout) return; // admin intent → proceed at deadline
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

// `step.waitForEvent` *rejects* when its timeout elapses (rather than returning a flag).
// Heuristic — confirm the real error shape against the live Workflows runtime.
function isWaitTimeout(e: unknown): boolean {
  return e instanceof Error && (e.name === 'TimeoutError' || /timed?\s*out/i.test(e.message));
}
