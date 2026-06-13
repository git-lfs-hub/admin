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

  /**
   * Record an object event. `source` is the operation; `last_seen`/`last_accessed`
   * bump on every event. `upload` only presigns a PUT, so R2 presence is unconfirmed
   * (`pending`); `verify`/`download` head-check R2 server-side, so they confirm `present`
   * and never downgrade an already-present object.
   */
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

  /**
   * Reconcile one page of storage truth (`oid -> size` for keys present under the
   * prefix): insert objects present in storage but absent from the index (as `present`,
   * source `storage_scan`), confirm `pending` objects to `present`, and correct sizes.
   * Callers stream pages from storage; only the page's oids are touched.
   */
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
        if (row.status === 'pending') {
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
      // Each row binds one var per column; chunk so `rows * cols` stays under
      // the var limit. Column count is taken from the row actually inserted.
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

  /**
   * Start (a shard of) an op. Refused while the prefix is busy with a *different* op (409);
   * another shard of the same op is allowed. Denormalizes `activeOp` onto `REGISTRY.storage`
   * so the list view shows running ops without fanning out.
   */
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

  /**
   * Close one op row with its engine status. When the last active row for the prefix closes,
   * write the resting `status` and clear `activeOp` on `REGISTRY.storage` (cross-DO).
   */
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

  /**
   * Close a completed BackUp. Unlike `endOp` it leaves the resting `status` alone and lands
   * `backedUpAt`/`backupComplete` instead (`Registry.endBackup`). Success-only — a cancelled BackUp
   * goes through `endOp` with status unchanged.
   */
  async endBackupOp(
    prefix: string,
    instanceId: string,
    archivedAtAtStart: string | null,
  ): Promise<void> {
    const last = await this.closeRow(instanceId, 'complete', null);
    if (last) await Registry.global(this.env).endBackup(prefix, archivedAtAtStart);
  }

  /**
   * Close a completed cold Restore. Like `endBackupOp` it leaves the resting `status` alone, but
   * clears the block (`archivedAt`/`clearedAt`) + `backupComplete` via `Registry.endRestore`.
   * Success-only — a cancelled Restore goes through `endOp` with status unchanged.
   */
  async endRestoreOp(prefix: string, instanceId: string): Promise<void> {
    const last = await this.closeRow(instanceId, 'complete', null);
    if (last) await Registry.global(this.env).endRestore(prefix);
  }

  /**
   * Close a completed Delete Backup. Leaves the resting `status` alone (live R2 untouched) and
   * clears the cold-copy flags (`backedUpAt`/`backupComplete`) via `Registry.endDeleteBackup`.
   * Success-only — a cancelled Delete Backup goes through `endOp` with status unchanged.
   */
  async endDeleteBackupOp(prefix: string, instanceId: string): Promise<void> {
    const last = await this.closeRow(instanceId, 'complete', null);
    if (last) await Registry.global(this.env).endDeleteBackup(prefix);
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
