import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';

import { Registry } from '@/db/registry';
import { Storage } from '@/db/storage';
import { startWorkflow, walkR2Pages } from '@/workflows/lifecycle';

export type ClearParams = {
  prefix: string; // STORAGE DO key + R2 key root (canonical OwnerCase/RepoCase)
};

// Clear: delete live R2, keep the cold copy. Stays blocked, status unchanged. Gated on a complete
// cold copy (clearing before backup finishes loses data).
export class ClearWorkflow extends WorkflowEntrypoint<CloudflareBindings, ClearParams> {
  async run(event: WorkflowEvent<ClearParams>, step: WorkflowStep): Promise<void> {
    const { prefix } = event.payload;

    await step.do('begin', async () => {
      const row = await Registry.global(this.env).getStorage(prefix);
      if (
        !row ||
        row.status === 'purged' ||
        !row.archivedAt ||
        !row.backupComplete ||
        row.clearedAt
      )
        throw new NonRetryableError('clear no longer eligible');
    });

    // Before the delete, so a crash mid-delete leaves Restore on the cold path.
    await step.do('mark', async () => {
      await Registry.global(this.env).markCleared(prefix);
    });

    await walkR2Pages(step, this.env.LFS_BUCKET, prefix, 'delete', async (objects) => {
      if (objects.length > 0) await this.env.LFS_BUCKET.delete(objects.map((o) => o.key));
    });

    await step.do('finish', () =>
      Storage.byPrefix(this.env, prefix).endClearOp(prefix, event.instanceId),
    );
  }
}

// Reserve the op (409 if the prefix is already busy) then create the workflow instance.
export function startClear(env: CloudflareBindings, params: ClearParams): Promise<string> {
  return startWorkflow(env, 'clear', env.CLEAR_WORKFLOW, params);
}
