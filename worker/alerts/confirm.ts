import { Alerts } from '@/db/alerts';
import type { ConfirmKind } from '@/db/alerts-schema';
import { Registry } from '@/db/registry';

// Workflow-side confirmation gate, kind-agnostic (purge now; clear in Group F). The pure,
// testable core: the gate decision (`readConfirmGate`) + the wait loop (`runConfirmation`).
// E4 supplies the real `WorkflowStep` adapter + the approve/cancel `sendEvent` wake.

export type ConfirmCtx = {
  env: CloudflareBindings;
  scope: string; // alert scope: storage:lc(owner/repo)
  prefix: string; // storage row key (canonical OwnerCase/RepoCase)
  kind: ConfirmKind;
  // Admin-initiated: proceed at the deadline (intent expressed). Cron (E7): false — always wait.
  proceedOnTimeout: boolean;
  timeout: string; // e.g. `${env.GC.purgeConfirmDays} days`
};

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

// Minimal `WorkflowStep` slice. E4's adapter catches the real `waitForEvent` timeout rejection
// and resolves `{ timedOut: true }`.
export interface ConfirmStep {
  do<T>(name: string, cb: () => Promise<T>): Promise<T>;
  waitForEvent(
    name: string,
    opts: { type: string; timeout: string },
  ): Promise<{ timedOut: boolean }>;
}

// Aborts the workflow at the gate (cancel hold / ineligible). E4 maps it to `NonRetryableError`.
export class ConfirmAborted extends Error {}

// Deliver, then loop on `waitForEvent`: approve → proceed; cancel/ineligible → throw; deadline
// (admin path only) → proceed.
export async function runConfirmation(step: ConfirmStep, ctx: ConfirmCtx): Promise<void> {
  const { kind } = ctx;
  await step.do(`confirm:${kind}:deliver`, () =>
    Alerts.global(ctx.env).sendConfirmation({ kind, scope: ctx.scope }),
  );

  for (;;) {
    const { timedOut } = await step.waitForEvent(`confirm:${kind}:wait`, {
      type: `alert_${kind}`,
      timeout: ctx.timeout,
    });
    const outcome = await step.do(`confirm:${kind}:gate`, () => readConfirmGate(ctx));
    if (outcome === 'terminate')
      throw new ConfirmAborted(`${kind} cancelled or no longer eligible`);
    if (outcome === 'proceed') return;
    if (timedOut && ctx.proceedOnTimeout) return; // admin intent → proceed at deadline
    // 'wait': stale/duplicate event, no decision yet — block again.
  }
}
