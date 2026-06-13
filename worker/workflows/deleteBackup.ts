import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';

import { Registry } from '@/db/registry';
import { Storage } from '@/db/storage';
import { s3DeleteObject } from '@/s3/delete';
import { startWorkflow, walkS3Pages } from '@/workflows/lifecycle';

export type DeleteBackupParams = {
  prefix: string; // STORAGE DO key + R2/S3 key root (canonical OwnerCase/RepoCase)
};

// Delete Backup: drop every cold-storage object, leaving live R2 untouched. Admin-only, no
// auto-trigger. Gated on a cold copy existing (`backedUpAt`) and live still present (`clearedAt`
// null) — once live is cleared the cold copy is the only copy, so deleting it would lose data.
export class DeleteBackupWorkflow extends WorkflowEntrypoint<
  CloudflareBindings,
  DeleteBackupParams
> {
  async run(event: WorkflowEvent<DeleteBackupParams>, step: WorkflowStep): Promise<void> {
    const { prefix } = event.payload;

    // Re-read guard: only a backed-up, not-cleared prefix is eligible at execution time.
    await step.do('begin', async () => {
      const row = await Registry.global(this.env).getStorage(prefix);
      if (!row || !row.backedUpAt || row.clearedAt)
        throw new NonRetryableError('delete-backup no longer eligible');
    });

    // Per-object delete is idempotent, so a retried page is safe.
    await walkS3Pages(step, this.env, prefix, 'delete', async (objects) => {
      await Promise.all(objects.map((o) => s3DeleteObject(this.env, o.key)));
    });

    await step.do('finish', () =>
      Storage.byPrefix(this.env, prefix).endDeleteBackupOp(prefix, event.instanceId),
    );
  }
}

// Reserve the op (409 if the prefix is already busy) then create the workflow instance.
export function startDeleteBackup(
  env: CloudflareBindings,
  params: DeleteBackupParams,
): Promise<string> {
  return startWorkflow(env, 'deleteBackup', env.DELETE_BACKUP_WORKFLOW, params);
}
