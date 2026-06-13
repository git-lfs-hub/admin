import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';

import { Registry } from '@/db/registry';
import { Storage } from '@/db/storage';
import { runConfirmation } from '@/workflows/confirm';
import { walkR2Pages } from '@/workflows/lifecycle';

// `prefix` is the STORAGE DO key + R2 key root (canonical OwnerCase/RepoCase). Auto (cron) clears
// wait for an explicit confirmation and so carry the alert `scope`; admin/inline clears run straight
// through (recoverable — the cold copy stays) and skip the gate, so they need no scope.
export type ClearParams =
  | { prefix: string; triggeredBy?: 'admin' }
  | { prefix: string; triggeredBy: 'auto'; scope: string }; // scope: storage:lc(owner/repo)

// Clear: delete live R2, keep the cold copy. Stays blocked, status unchanged. Gated on a complete
// cold copy (clearing before backup finishes loses data).
export class ClearWorkflow extends WorkflowEntrypoint<CloudflareBindings, ClearParams> {
  async run(event: WorkflowEvent<ClearParams>, step: WorkflowStep): Promise<void> {
    const { prefix } = event.payload;

    // Cron-initiated → wait-only confirmation gate (no human intent → never proceeds at a deadline).
    // Cancel/ineligible throws ConfirmAborted (terminal). Admin/inline path skips the gate.
    if (event.payload.triggeredBy === 'auto')
      await runConfirmation(step, {
        env: this.env,
        scope: event.payload.scope,
        prefix,
        kind: 'clear',
        triggeredBy: 'auto',
      });

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

    // Bulk delete is idempotent, so a retried page is safe.
    await walkR2Pages(this.env.LFS_BUCKET, prefix, step, 'r2-delete', async (objects) => {
      if (objects.length > 0) await this.env.LFS_BUCKET.delete(objects.map((o) => o.key));
    });

    await step.do('finish', () =>
      Storage.byPrefix(this.env, prefix).endClearOp(prefix, event.instanceId),
    );
  }
}
