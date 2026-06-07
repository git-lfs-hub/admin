import { DurableObject } from 'cloudflare:workers';
import { count, eq, inArray, max, sum } from 'drizzle-orm';
import { drizzle, DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';

import { objects, objectStatuses, type ObjectStatus } from '@/db/repo-schema';
import { isoNow } from '@/lib/time';

export type ObjectRow = typeof objects.$inferSelect;

/** CF Durable Object SQLite caps bound parameters per statement at 100. */
const SQL_VAR_LIMIT = 100;

/** Object count + total size per status. Presentation is left to the UI. */
export type UsageByStatus = Record<ObjectStatus, { count: number; size: number }>;

export type ObjectReconciliationResult = {
  added: number; // present in storage, absent from index → inserted as present
  confirmed: number; // pending → present
  resized: number; // size corrected from storage truth
};

/** Per-repo index DO (keyed by `${owner}/${repo}`). Tracks LFS objects. */
export class Repo extends DurableObject<CloudflareBindings> {
  private db: DrizzleSqliteDODatabase;

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
   * repo prefix): insert objects present in storage but absent from the index
   * (as `present`, source `storage_scan`), confirm `pending` objects to `present`,
   * and correct sizes. Callers stream pages from storage; only the page's oids
   * are touched (objects absent from storage are left untouched).
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
}
