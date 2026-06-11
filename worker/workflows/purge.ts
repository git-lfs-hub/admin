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

export type PurgeParams = {
  prefix: string; // STORAGE DO key + R2 key root (canonical OwnerCase/RepoCase)
  scope: string; // alert scope (storage:lc(owner/repo))
  triggeredBy: 'admin' | 'auto';
};

type DeletePage = { prefix: string; cursor?: string };

// No-cold-storage Purge: confirmation gate → delete live R2 in batches → purgeRepo → `purged`.
// Cold-storage path (delete S3 too) is not yet implemented.
export class PurgeWorkflow extends WorkflowEntrypoint<CloudflareBindings, PurgeParams> {
  async run(event: WorkflowEvent<PurgeParams>, step: WorkflowStep): Promise<void> {
    const { prefix, scope, triggeredBy } = event.payload;

    // Admin-initiated: proceed when the grace deadline elapses (intent already expressed).
    // Cron-triggered: wait-only. Cancel/ineligible throws ConfirmAborted (terminal, no retry).
    await runConfirmation(step, {
      env: this.env,
      scope,
      prefix,
      kind: 'purge',
      proceedOnTimeout: triggeredBy === 'admin',
      timeout: `${gcConfig(this.env).purgeConfirmDays} days`,
    });

    // Re-read at execution time — abort if the repo reappeared / was already purged.
    await step.do('guard', async () => {
      const row = await Registry.global(this.env).getStorage(prefix);
      if (!row || row.status === 'purged' || !row.archivedAt)
        throw new NonRetryableError('purge no longer eligible');
    });

    let page: DeletePage = { prefix: `${prefix}/` };
    let n = 0;
    do {
      page = await step.do(`delete:${n}`, () => this.deleteR2Page(page));
      n++;
    } while (page.cursor);

    await step.do('server-cleanup', () => purgeServer(this.env, prefix));

    await step.do('finish', () =>
      Storage.byPrefix(this.env, prefix).endOp(prefix, event.instanceId, 'complete', 'purged'),
    );
  }

  // Returns only the next cursor, never the key list — step return values are persisted, keep small.
  // Bulk delete is idempotent, so a retried step is safe.
  private async deleteR2Page(page: DeletePage): Promise<DeletePage> {
    const list = await this.env.LFS_BUCKET.list(page);
    if (list.objects.length > 0) {
      await this.env.LFS_BUCKET.delete(list.objects.map((o) => o.key));
    }
    return { prefix: page.prefix, cursor: list.truncated ? list.cursor : undefined };
  }
}

// Deterministic single-shard id — `create()` throws on a live duplicate (idempotent trigger);
// approve/cancel reconstruct it from the prefix to wake the waiting instance. Workflow instance
// ids must match `^[a-zA-Z0-9_][a-zA-Z0-9-_]*$` (no `/`, `.`, or `:`, which prefixes carry), so
// hash the prefix instead of embedding it.
export function purgeInstanceId(prefix: string): string {
  return workflowInstanceId('purge', prefix);
}

// Reserve the op (409 if the prefix is already busy) then create the workflow instance.
export async function startPurge(env: CloudflareBindings, params: PurgeParams): Promise<string> {
  const id = purgeInstanceId(params.prefix);
  await Storage.byPrefix(env, params.prefix).beginOp(params.prefix, id, 'purge');
  await env.PURGE_WORKFLOW.create({ id, params });
  return id;
}

// Wake the waiting purge instance after an approve/cancel. Maps the alert scope back to the
// canonical prefix (same-key lookup) to rebuild the deterministic id. Best-effort: if the
// instance is gone the gate re-reads the decision on the next cron repair.
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
