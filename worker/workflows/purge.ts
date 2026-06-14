import { type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';

import { Registry } from '@/db/registry';
import { Storage } from '@/db/storage';
import { gcConfig } from '@/gc/config';
import { s3DeleteObject } from '@/s3/delete';
import { purgeServer } from '@/server/operations';
import { runConfirmation } from '@/workflows/confirm';
import { LifecycleWorkflow } from '@/workflows/lifecycle';

export type PurgeParams = {
  prefix: string; // STORAGE DO key + R2 key root (canonical OwnerCase/RepoCase)
  scope: string; // alert scope (storage:lc(owner/repo))
  triggeredBy: 'admin' | 'auto';
};

// Purge: confirmation gate → delete live R2 in batches → (cold storage) delete the cold S3 copy →
// purgeRepo → `purged`. With cold storage on, live R2 may already be cleared (the live walk is then a
// no-op) but the cold copy still needs dropping.
export class PurgeWorkflow extends LifecycleWorkflow<PurgeParams> {
  protected async execute(event: WorkflowEvent<PurgeParams>, step: WorkflowStep): Promise<void> {
    const { prefix, scope, triggeredBy } = event.payload;

    // Admin: proceed at the grace deadline (intent expressed).
    // Cron: wait-only. Cancel/ineligible throws ConfirmAborted (terminal, no retry).
    await runConfirmation(step, {
      env: this.env,
      scope,
      prefix,
      kind: 'purge',
      triggeredBy,
    });

    // Re-read guard: abort if the repo reappeared / was already purged.
    await step.do('begin', async () => {
      const row = await Registry.global(this.env).getStorage(prefix);
      if (!row || row.status === 'purged' || !row.archivedAt)
        throw new NonRetryableError('purge no longer eligible');
    });

    // Bulk delete is idempotent, so a retried page is safe.
    await this.walkR2Pages(prefix, step, 'r2-delete', async (objects) => {
      if (objects.length > 0) await this.env.LFS_BUCKET.delete(objects.map((o) => o.key));
    });

    if (gcConfig(this.env).coldStorage)
      // Drop the cold (S3) copy too. Per-object DELETE is idempotent.
      await this.walkS3Pages(prefix, step, 's3-delete', async (objects) => {
        await Promise.all(objects.map((o) => s3DeleteObject(this.env, o.key)));
      });

    await step.do('server-cleanup', () => purgeServer(this.env, prefix));

    await step.do('finish', () =>
      Storage.byPrefix(this.env, prefix).endPurgeOp(prefix, event.instanceId),
    );
  }
}
