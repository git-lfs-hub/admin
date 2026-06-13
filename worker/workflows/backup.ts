import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';

import { Registry } from '@/db/registry';
import { Storage } from '@/db/storage';
import { copyR2toS3 } from '@/s3/backup';
import { startWorkflow, walkR2Pages } from '@/workflows/lifecycle';

export type BackupParams = {
  prefix: string; // STORAGE DO key + R2 key root (canonical OwnerCase/RepoCase)
};

// BackUp: copy every live R2 object to cold storage (`GLACIER_IR`), then land `backedUpAt`. Runs on
// any non-purged prefix and never blocks (Archive does). `backupComplete` is earned only if the
// prefix stayed blocked under the same `archivedAt` the whole run (see `Registry.endBackup`).
export class BackupWorkflow extends WorkflowEntrypoint<CloudflareBindings, BackupParams> {
  async run(event: WorkflowEvent<BackupParams>, step: WorkflowStep): Promise<void> {
    const { prefix } = event.payload;

    // Captured at start; the finish step compares it to decide `backupComplete`.
    const archivedAtAtStart = await step.do('begin', async () => {
      const row = await Registry.global(this.env).getStorage(prefix);
      if (!row || row.status === 'purged') throw new NonRetryableError('backup no longer eligible');
      return row.archivedAt;
    });

    // Per-object HEAD-skip makes a retried page re-do no completed work.
    await walkR2Pages(step, this.env.LFS_BUCKET, prefix, 'copy', async (objects) => {
      await Promise.all(objects.map((o) => copyR2toS3(this.env, o.key, 'GLACIER_IR')));
    });

    await step.do('finish', () =>
      Storage.byPrefix(this.env, prefix).endBackupOp(prefix, event.instanceId, archivedAtAtStart),
    );
  }
}

// Reserve the op (409 if the prefix is already busy) then create the workflow instance.
export function startBackup(env: CloudflareBindings, params: BackupParams): Promise<string> {
  return startWorkflow(env, 'backup', env.BACKUP_WORKFLOW, params);
}
