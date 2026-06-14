import { type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';

import { Registry } from '@/db/registry';
import { Storage } from '@/db/storage';
import { copyObject } from '@/s3/copy';
import { r2Store } from '@/s3/r2-store';
import { s3Store } from '@/s3/s3-store';
import { LifecycleWorkflow } from '@/workflows/lifecycle';

export type BackupParams = {
  prefix: string; // STORAGE DO key + R2 key root (canonical OwnerCase/RepoCase)
};

// BackUp: copy every live R2 object to cold storage (`GLACIER_IR`), then land `backedUpAt`.
// `backupComplete` is earned only if the prefix stayed blocked under the same `archivedAt` the whole
// run (see `Registry.endBackup`).
export class BackupWorkflow extends LifecycleWorkflow<BackupParams> {
  protected async execute(event: WorkflowEvent<BackupParams>, step: WorkflowStep): Promise<void> {
    const { prefix } = event.payload;

    // Captured at start; the finish step compares it to decide `backupComplete`.
    const archivedAtAtStart = await step.do('begin', async () => {
      const row = await Registry.global(this.env).getStorage(prefix);
      if (!row || row.status === 'purged') throw new NonRetryableError('backup no longer eligible');
      return row.archivedAt;
    });

    // Per-object HEAD-skip (in `copyObject`) makes a retried page redo no completed work.
    const src = r2Store(this.env);
    const dst = s3Store(this.env, 'GLACIER_IR');
    await this.walkR2Pages(prefix, step, 'backup-obj', async (objects) => {
      await Promise.all(objects.map((o) => copyObject(o.key, src, dst)));
    });

    await step.do('finish', () =>
      Storage.byPrefix(this.env, prefix).endBackupOp(prefix, event.instanceId, archivedAtAtStart),
    );
  }
}
