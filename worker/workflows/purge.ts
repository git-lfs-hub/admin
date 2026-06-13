import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';

import { scopeLabel } from '@/alerts/message';
import type { Decision } from '@/db/alerts-schema';
import { Registry } from '@/db/registry';
import { Storage } from '@/db/storage';
import { gcConfig } from '@/gc/config';
import { purgeServer } from '@/server/operations';
import { runConfirmation } from '@/workflows/confirm';
import { workflowInstanceId } from '@/workflows/instanceId';
import { startWorkflow, walkR2Pages } from '@/workflows/lifecycle';

export type PurgeParams = {
  prefix: string; // STORAGE DO key + R2 key root (canonical OwnerCase/RepoCase)
  scope: string; // alert scope (storage:lc(owner/repo))
  triggeredBy: 'admin' | 'auto';
};

// No-cold-storage Purge: confirmation gate → delete live R2 in batches → purgeRepo → `purged`.
// Cold-storage path (delete S3 too) is not yet implemented.
export class PurgeWorkflow extends WorkflowEntrypoint<CloudflareBindings, PurgeParams> {
  async run(event: WorkflowEvent<PurgeParams>, step: WorkflowStep): Promise<void> {
    const { prefix, scope, triggeredBy } = event.payload;

    // Admin: proceed at the grace deadline (intent expressed). Cron: wait-only. Cancel/ineligible
    // throws ConfirmAborted (terminal, no retry).
    await runConfirmation(step, {
      env: this.env,
      scope,
      prefix,
      kind: 'purge',
      proceedOnTimeout: triggeredBy === 'admin',
      timeout: `${gcConfig(this.env).purgeConfirmDays} days`,
    });

    // Re-read guard — abort if the repo reappeared / was already purged.
    await step.do('guard', async () => {
      const row = await Registry.global(this.env).getStorage(prefix);
      if (!row || row.status === 'purged' || !row.archivedAt)
        throw new NonRetryableError('purge no longer eligible');
    });

    // Bulk delete is idempotent, so a retried page is safe.
    await walkR2Pages(step, this.env.LFS_BUCKET, prefix, 'delete', async (objects) => {
      if (objects.length > 0) await this.env.LFS_BUCKET.delete(objects.map((o) => o.key));
    });

    await step.do('server-cleanup', () => purgeServer(this.env, prefix));

    await step.do('finish', () =>
      Storage.byPrefix(this.env, prefix).endOp(prefix, event.instanceId, 'complete', 'purged'),
    );
  }
}

// Deterministic id — `create()` throws on a live duplicate (idempotent trigger); approve/cancel + the
// cron repair reconstruct it from the prefix to wake/heal the instance.
export function purgeInstanceId(prefix: string): string {
  return workflowInstanceId('purge', prefix);
}

// Reserve the op (409 if the prefix is already busy) then create the workflow instance.
export function startPurge(env: CloudflareBindings, params: PurgeParams): Promise<string> {
  return startWorkflow(env, 'purge', env.PURGE_WORKFLOW, params);
}

// Wake the waiting purge instance after an approve/cancel. Best-effort: if the instance is gone the
// gate re-reads the decision on the next cron repair.
export async function wakePurge(
  env: CloudflareBindings,
  scope: string,
  decision: Decision,
  by: string,
): Promise<void> {
  const [owner, repo] = scopeLabel(scope).split('/');
  const row = await Registry.global(env).storageForRepo(owner, repo);
  if (!row) return;
  try {
    const instance = await env.PURGE_WORKFLOW.get(purgeInstanceId(row.prefix));
    await instance.sendEvent({ type: 'alert_purge', payload: { decision, by } });
  } catch {
    // instance already finished/terminated — nothing to wake
  }
}
