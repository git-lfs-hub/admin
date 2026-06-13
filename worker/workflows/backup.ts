import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';

import { Registry } from '@/db/registry';
import { Storage } from '@/db/storage';
import { copyR2toS3 } from '@/s3/backup';
import { workflowInstanceId } from '@/workflows/instanceId';

export type BackupParams = {
  prefix: string; // STORAGE DO key + R2 key root (canonical OwnerCase/RepoCase)
};

type ListPage = { prefix: string; cursor?: string };

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

    let page: ListPage = { prefix: `${prefix}/` };
    let n = 0;
    do {
      page = await step.do(`copy:${n}`, () => this.backupR2Page(page));
      n++;
    } while (page.cursor);

    await step.do('finish', () =>
      Storage.byPrefix(this.env, prefix).endBackupOp(prefix, event.instanceId, archivedAtAtStart),
    );
  }

  // Return only the next cursor — step return values are persisted, keep them small. Per-object
  // HEAD-skip makes a retried page re-do no completed work.
  private async backupR2Page(page: ListPage): Promise<ListPage> {
    const list = await this.env.LFS_BUCKET.list(page);
    await Promise.all(list.objects.map((o) => copyR2toS3(this.env, o.key, 'GLACIER_IR')));
    return { prefix: page.prefix, cursor: list.truncated ? list.cursor : undefined };
  }
}

// Deterministic single-shard id — `create()` throws on a live duplicate (idempotent trigger).
export function backupInstanceId(prefix: string): string {
  return workflowInstanceId('backup', prefix);
}

// Reserve the op (409 if the prefix is already busy) then create the workflow instance.
export async function startBackup(env: CloudflareBindings, params: BackupParams): Promise<string> {
  const id = backupInstanceId(params.prefix);
  await Storage.byPrefix(env, params.prefix).beginOp(params.prefix, id, 'backup');
  await env.BACKUP_WORKFLOW.create({ id, params });
  return id;
}
