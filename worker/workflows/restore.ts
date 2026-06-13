import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';

import { Registry } from '@/db/registry';
import { Storage } from '@/db/storage';
import { copyS3toR2, s3HeadRestored, s3RestoreObject } from '@/s3/restore';
import { unblockServer } from '@/server/operations';
import { startWorkflow, walkS3Pages } from '@/workflows/lifecycle';

export type RestoreParams = {
  prefix: string; // STORAGE DO key + R2/S3 key root (canonical OwnerCase/RepoCase)
};

// Cold Restore: live R2 was cleared (`clearedAt` set), so pull every object back from cold storage,
// thawing colder Glacier tiers first, then unblock. Repo stays blocked (`archivedAt` set) the whole
// retrieval window — days for Deep Archive. Admin-only; no confirmation gate.
export class RestoreWorkflow extends WorkflowEntrypoint<CloudflareBindings, RestoreParams> {
  async run(event: WorkflowEvent<RestoreParams>, step: WorkflowStep): Promise<void> {
    const { prefix } = event.payload;

    // Re-read guard: only a blocked, cleared, non-purged prefix needs cold retrieval.
    await step.do('begin', async () => {
      const row = await Registry.global(this.env).getStorage(prefix);
      if (!row || row.status === 'purged' || !row.archivedAt || !row.clearedAt)
        throw new NonRetryableError('restore no longer eligible');
    });

    // Three passes, NOT thaw→wait→pull per page: a colder tier's retrieval takes hours-to-days, so
    // thaw EVERY page first — S3 then retrieves them concurrently — and wait ONCE for the whole set,
    // else page N's wait stacks on page N-1's (total = sum of waits, not the slowest). Each sub-step
    // re-lists its page via the `list()` thunk, so no key list is persisted across the sleeps
    // (instance state stays cursor-sized regardless of object count).

    // 1. Initiate the async retrieval for every colder object (no-op for `GLACIER_IR`; idempotent).
    await walkS3Pages(step, this.env, prefix, 'thaw', async (objects) => {
      await Promise.all(objects.filter(colder).map((o) => s3RestoreObject(this.env, o.key)));
    });

    // 2. Wait until every page's colder objects are retrievable — one shared retrieval window. The
    // first scan of a `GLACIER_IR`-only restore finds nothing colder, so it's ready at once, no sleep.
    for (let t = 0; ; t++) {
      const allReady = await walkS3Pages(step, this.env, prefix, `poll:${t}`, async (objects) => {
        const states = await Promise.all(
          objects.filter(colder).map((o) => s3HeadRestored(this.env, o.key)),
        );
        return states.every(Boolean);
      });
      if (allReady) break;
      await step.sleep(`wait:${t}`, '1 hour');
    }

    // 3. Pull every (now-retrievable) object back into live R2.
    await walkS3Pages(step, this.env, prefix, 'pull', async (objects) => {
      await Promise.all(objects.map((o) => copyS3toR2(this.env, o.key)));
    });

    await step.do('unblock', () => unblockServer(this.env, prefix));
    await step.do('finish', () =>
      Storage.byPrefix(this.env, prefix).endRestoreOp(prefix, event.instanceId),
    );
  }
}

// `GLACIER_IR` is read immediately; colder tiers (`GLACIER`/`DEEP_ARCHIVE`) need an async
// `RestoreObject` + retrieval wait first.
function colder(o: { storageClass: string }): boolean {
  return o.storageClass !== 'GLACIER_IR';
}

// Reserve the op (409 if the prefix is already busy) then create the workflow instance.
export function startRestore(env: CloudflareBindings, params: RestoreParams): Promise<string> {
  return startWorkflow(env, 'restore', env.RESTORE_WORKFLOW, params);
}
