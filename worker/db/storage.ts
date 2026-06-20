import { DurableObject } from 'cloudflare:workers';
import { and, count, eq, inArray, isNull, max, sum } from 'drizzle-orm';
import { drizzle, DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';

import { Registry } from '@/db/registry';
import type { StorageStatus } from '@/db/registry-schema';
import {
  objects,
  objectStatuses,
  workflows,
  type ObjectStatus,
  type WorkflowOp,
  type WorkflowStatus,
} from '@/db/storage-schema';
import { isoNow } from '@/lib/time';

export type ObjectRow = typeof objects.$inferSelect;
export type WorkflowRow = typeof workflows.$inferSelect;

/** CF Durable Object SQLite caps bound parameters per statement at 100. */
const SQL_VAR_LIMIT = 100;

/** Object count + total size per status. Presentation is left to the UI. */
export type UsageByStatus = Record<ObjectStatus, { count: number; size: number }>;

export type ObjectReconciliationResult = {
  added: number; // present in storage, absent from index → inserted as present
  confirmed: number; // pending → present
  resized: number; // size corrected from storage truth
};

/** Per-prefix storage DO (keyed by the canonical `OwnerCase/RepoCase` prefix). Holds the LFS
 *  object inventory and the `workflows` table (one-active-op guard for the GC lifecycle). */
export class Storage extends DurableObject<CloudflareBindings> {
  private db: DrizzleSqliteDODatabase;

  static byPrefix(env: CloudflareBindings, prefix: string): DurableObjectStub<Storage> {
    return env.STORAGE.getByName(prefix);
  }

  constructor(ctx: DurableObjectState, env: CloudflareBindings) {
    super(ctx, env);
    this.db = drizzle(ctx.storage);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS objects (
          oid           TEXT PRIMARY KEY,
          size          INTEGER NOT NULL,
          status        TEXT NOT NULL DEFAULT 'pending',
          source        TEXT NOT NULL,
          first_seen    TEXT NOT NULL,
          last_seen     TEXT NOT NULL,
          last_accessed TEXT NOT NULL
        )
      `);
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS workflows (
          instance_id         TEXT PRIMARY KEY,
          op                  TEXT NOT NULL,
          shard               INTEGER,
          status              TEXT NOT NULL,
          started_at          TEXT NOT NULL,
          ended_at            TEXT,
          cancel_requested_at TEXT,
          error               TEXT
        )
      `);
      this.ctx.storage.sql.exec(
        `CREATE INDEX IF NOT EXISTS workflows_active ON workflows (ended_at)`,
      );
    });
  }

  async getObject(oid: string): Promise<ObjectRow | null> {
    const [row] = await this.db.select().from(objects).where(eq(objects.oid, oid));
    return row ?? null;
  }

  async listObjects(): Promise<ObjectRow[]> {
    return await this.db.select().from(objects);
  }

  /** Record an object event. `upload` only presigns a PUT → `pending` (R2 unconfirmed);
   *  `verify`/`download` head-check server-side → confirm `present`, never downgrade. */
  async recordObject(
    oid: string,
    size: number,
    operation: 'upload' | 'verify' | 'download',
  ): Promise<ObjectRow> {
    const now = isoNow();
    const confirmed = operation !== 'upload';
    const [row] = await this.db
      .insert(objects)
      .values({
        oid,
        size,
        status: confirmed ? 'present' : 'pending',
        source: operation,
        firstSeen: now,
        lastSeen: now,
        lastAccessed: now,
      })
      .onConflictDoUpdate({
        target: objects.oid,
        set: {
          size,
          lastSeen: now,
          lastAccessed: now,
          ...(confirmed ? { status: 'present' } : {}),
        },
      })
      .returning();
    return row;
  }

  /** Object count and total size broken down by status (zero-filled). */
  async usage(): Promise<UsageByStatus> {
    const rows = await this.db
      .select({
        status: objects.status,
        count: count(),
        size: sum(objects.size),
      })
      .from(objects)
      .groupBy(objects.status);
    const out = Object.fromEntries(
      objectStatuses.map((s) => [s, { count: 0, size: 0 }]),
    ) as UsageByStatus;
    for (const r of rows) out[r.status] = { count: r.count, size: Number(r.size ?? 0) };
    return out;
  }

  /** Most recent `last_accessed` across all objects, or null for an empty index. */
  async lastAccessedAt(): Promise<string | null> {
    const [row] = await this.db.select({ value: max(objects.lastAccessed) }).from(objects);
    return row?.value ?? null;
  }

  /** Reconcile one page of storage truth (`oid -> size`): insert keys absent from the index
   *  (`present`, source `storage_scan`), confirm `pending`/`missing` → `present`, correct sizes.
   *  Only the page's oids are touched; the cross-page sweep is `sweepMissing`. */
  async recordReconciliation(
    storageSizes: Record<string, number>,
  ): Promise<ObjectReconciliationResult> {
    const out: ObjectReconciliationResult = { added: 0, confirmed: 0, resized: 0 };
    const oids = Object.keys(storageSizes);
    const now = isoNow();
    // Chunk the IN lookup to stay under SQLite's bound-variable limit.
    for (let i = 0; i < oids.length; i += SQL_VAR_LIMIT) {
      const chunk = oids.slice(i, i + SQL_VAR_LIMIT);
      const rows = await this.db.select().from(objects).where(inArray(objects.oid, chunk));
      const seen = new Set(rows.map((r) => r.oid));
      for (const row of rows) {
        const storageSize = storageSizes[row.oid];
        const set: Partial<typeof objects.$inferInsert> = {};
        if (row.status === 'pending' || row.status === 'missing') {
          set.status = 'present';
          out.confirmed++;
        }
        if (row.size !== storageSize) {
          set.size = storageSize;
          out.resized++;
        }
        if (Object.keys(set).length > 0) {
          await this.db.update(objects).set(set).where(eq(objects.oid, row.oid));
        }
      }

      const inserts = chunk
        .filter((oid) => !seen.has(oid))
        .map((oid) => ({
          oid,
          size: storageSizes[oid],
          status: 'present' as const,
          source: 'storage_scan' as const,
          firstSeen: now,
          lastSeen: now,
          lastAccessed: now,
        }));
      // Chunk so `rows * cols` stays under the var limit (column count from the inserted row).
      if (inserts.length > 0) {
        const batch_rows = Math.floor(SQL_VAR_LIMIT / Object.keys(inserts[0]).length);
        for (let j = 0; j < inserts.length; j += batch_rows) {
          const batch = inserts.slice(j, j + batch_rows);
          await this.db.insert(objects).values(batch);
          out.added += batch.length;
        }
      }
    }
    return out;
  }

  /** Close out a full prefix scan: every `present` row whose oid the scan never listed has lost
   *  its R2 bytes → `missing`. `pending` is left alone — a presigned upload that never landed was
   *  never in R2, so its absence is expected, not loss. `seenOids` is the complete set the scan
   *  enumerated across all pages. Returns the count newly marked. The inverse — bytes reappearing —
   *  is recovered by `recordReconciliation` (`missing` → `present`). */
  async sweepMissing(seenOids: string[]): Promise<number> {
    const seen = new Set(seenOids);
    const rows = await this.db
      .select({ oid: objects.oid })
      .from(objects)
      .where(eq(objects.status, 'present'));
    const stale = rows.map((r) => r.oid).filter((oid) => !seen.has(oid));
    for (let i = 0; i < stale.length; i += SQL_VAR_LIMIT) {
      const chunk = stale.slice(i, i + SQL_VAR_LIMIT);
      await this.db.update(objects).set({ status: 'missing' }).where(inArray(objects.oid, chunk));
    }
    return stale.length;
  }

  // --- workflows: one-active-op guard for the GC lifecycle (executors live in worker/workflows) ---

  async listWorkflows(): Promise<WorkflowRow[]> {
    return await this.db.select().from(workflows);
  }

  /** The prefix is busy iff ≥1 row has `endedAt` null. */
  async activeOp(): Promise<WorkflowOp | null> {
    const [row] = await this.db
      .select({ op: workflows.op })
      .from(workflows)
      .where(isNull(workflows.endedAt))
      .limit(1);
    return row?.op ?? null;
  }

  /** Instance id of the active (un-ended) `op`, for waking/cancelling it. Null if none. */
  async activeInstanceId(op: WorkflowOp): Promise<string | null> {
    const [row] = await this.db
      .select({ instanceId: workflows.instanceId })
      .from(workflows)
      .where(and(isNull(workflows.endedAt), eq(workflows.op, op)))
      .limit(1);
    return row?.instanceId ?? null;
  }

  /** Start (a shard of) an op. Refused while busy with a *different* op (409); same-op shards
   *  allowed. Denormalizes `activeOp` onto `REGISTRY.storage` (list view, no fan-out). */
  async beginOp(
    prefix: string,
    instanceId: string,
    op: WorkflowOp,
    shard: number | null = null,
  ): Promise<WorkflowRow> {
    const active = await this.activeOp();
    if (active && active !== op) {
      throw new Error(`storage busy: ${active} in flight, cannot start ${op}`);
    }
    const now = isoNow();
    const [row] = await this.db
      .insert(workflows)
      .values({ instanceId, op, shard, status: 'running', startedAt: now })
      .returning();
    if (!active) await Registry.global(this.env).setActiveOp(prefix, op);
    return row;
  }

  /** Close one op row. On the last active row closing, write resting `status` + clear `activeOp`
   *  on `REGISTRY.storage` (cross-DO). */
  async endOp(
    prefix: string,
    instanceId: string,
    engineStatus: WorkflowStatus,
    restingStatus: StorageStatus,
    error: string | null = null,
  ): Promise<void> {
    const last = await this.closeRow(instanceId, engineStatus, error);
    if (last) await Registry.global(this.env).endStorageOp(prefix, restingStatus);
  }

  /** Close a completed BackUp: lands `backedUpAt`/`backupComplete` via `Registry.endBackup`,
   *  status untouched. Success-only (a cancelled BackUp goes through `endOp`). */
  async endBackupOp(
    prefix: string,
    instanceId: string,
    archivedAtAtStart: string | null,
  ): Promise<void> {
    const last = await this.closeRow(instanceId, 'complete', null);
    if (last) await Registry.global(this.env).endBackup(prefix, archivedAtAtStart);
  }

  /** Close a completed cold Restore: clears the block (`archivedAt`/`clearedAt`) + `backupComplete`
   *  via `Registry.endRestore`, status untouched. Success-only. */
  async endRestoreOp(prefix: string, instanceId: string): Promise<void> {
    const last = await this.closeRow(instanceId, 'complete', null);
    if (last) await Registry.global(this.env).endRestore(prefix);
  }

  /** Close a completed Clear via `Registry.endClear` (status untouched). Success-only. */
  async endClearOp(prefix: string, instanceId: string): Promise<void> {
    const last = await this.closeRow(instanceId, 'complete', null);
    if (last) await Registry.global(this.env).endClear(prefix);
  }

  /** Close a completed Delete Backup: clears `backedUpAt`/`backupComplete` via
   *  `Registry.endDeleteBackup`, status untouched. Success-only. */
  async endDeleteBackupOp(prefix: string, instanceId: string): Promise<void> {
    const last = await this.closeRow(instanceId, 'complete', null);
    if (last) await Registry.global(this.env).endDeleteBackup(prefix);
  }

  /** Close a completed Purge: resting status → `purged`. Success-only (a terminated purge goes
   *  through `endOp`). */
  async endPurgeOp(prefix: string, instanceId: string): Promise<void> {
    await this.endOp(prefix, instanceId, 'complete', 'purged');
  }

  /** Mark one instance's row ended; returns true when no active row remains for the prefix. */
  private async closeRow(
    instanceId: string,
    engineStatus: WorkflowStatus,
    error: string | null,
  ): Promise<boolean> {
    const now = isoNow();
    await this.db
      .update(workflows)
      .set({ status: engineStatus, endedAt: now, error })
      .where(eq(workflows.instanceId, instanceId));
    return (await this.activeOp()) === null;
  }

  /** Flag every active row for cancellation; the executors check this at batch boundaries. */
  async requestCancel(): Promise<number> {
    const now = isoNow();
    const rows = await this.db
      .update(workflows)
      .set({ cancelRequestedAt: now })
      .where(and(isNull(workflows.endedAt), isNull(workflows.cancelRequestedAt)))
      .returning();
    return rows.length;
  }
}
