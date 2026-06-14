import { type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';

import { Registry } from '@/db/registry';
import { Storage } from '@/db/storage';
import { copyObject } from '@/s3/copy';
import { r2Store } from '@/s3/r2-store';
import { s3NeedsThaw, s3Ready, s3RestoreObject } from '@/s3/restore';
import { s3Store } from '@/s3/s3-store';
import { unblockServer } from '@/server/operations';
import { LifecycleWorkflow } from '@/workflows/lifecycle';

export type RestoreParams = {
  prefix: string; // STORAGE DO key + R2/S3 key root (canonical OwnerCase/RepoCase)
};

// Cold Restore: live R2 was cleared (`clearedAt` set), so pull every object back from cold storage,
// thawing colder Glacier tiers first, then unblock. Repo stays blocked (`archivedAt` set) the whole
// retrieval window — days for Deep Archive.
export class RestoreWorkflow extends LifecycleWorkflow<RestoreParams> {
  protected async execute(event: WorkflowEvent<RestoreParams>, step: WorkflowStep): Promise<void> {
    const { prefix } = event.payload;

    // Re-read guard: only a blocked, cleared, non-purged prefix needs cold retrieval.
    await step.do('begin', async () => {
      const row = await Registry.global(this.env).getStorage(prefix);
      if (!row || row.status === 'purged' || !row.archivedAt || !row.clearedAt)
        throw new NonRetryableError('restore no longer eligible');
    });

    // Thaw EVERY page before waiting, so the retrieval windows overlap (one shared wait, not a sum
    // over pages). Each sub-step re-lists its page, so no key list persists across the sleeps.

    // 1. Initiate the async retrieval for every colder object (no-op for `GLACIER_IR`; idempotent)
    await this.walkS3Pages(prefix, step, 'thaw', async (objects) => {
      await Promise.all(objects.filter(s3NeedsThaw).map((o) => s3RestoreObject(this.env, o)));
    });

    // 2. Wait until every page's colder objects are retrievable — one shared retrieval window. The
    // first scan of a `GLACIER_IR`-only restore finds nothing colder, so it's ready at once, no sleep.
    for (let t = 0; ; t++) {
      const label = `poll-thawed:${t}`;
      const allReady = await this.walkS3Pages(prefix, step, label, async (objects) => {
        const states = await Promise.all(
          objects.filter(s3NeedsThaw).map((o) => s3Ready(this.env, o)),
        );
        return states.every(Boolean);
      });
      if (allReady) break;
      await step.sleep(`wait:${t}`, '1 hour');
    }

    // 3. Pull every (now-retrievable) object back into live R2.
    const src = s3Store(this.env);
    const dst = r2Store(this.env);
    await this.walkS3Pages(prefix, step, 'restore-obj', async (objects) => {
      await Promise.all(objects.map((o) => copyObject(o.key, src, dst)));
    });

    await step.do('unblock', () => unblockServer(this.env, prefix));

    await step.do('finish', () =>
      Storage.byPrefix(this.env, prefix).endRestoreOp(prefix, event.instanceId),
    );
  }
}
