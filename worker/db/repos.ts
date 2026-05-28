import { DurableObject } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { drizzle, DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";

import { isoNow } from "@/lib/time";
import { repos, type RepoStatus } from "@/db/_repos-schema";

export type RepoRow = typeof repos.$inferSelect;

function byKey(owner: string, repo: string) {
  return and(eq(repos.owner, owner), eq(repos.repo, repo));
}

export class Repos extends DurableObject<CloudflareBindings> {
  private db: DrizzleSqliteDODatabase;

  constructor(ctx: DurableObjectState, env: CloudflareBindings) {
    super(ctx, env);
    this.db = drizzle(ctx.storage);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS repos (
          owner          TEXT NOT NULL,
          repo           TEXT NOT NULL,
          status         TEXT NOT NULL DEFAULT 'active',
          first_seen     TEXT NOT NULL,
          updated_at     TEXT NOT NULL,
          missing_at     TEXT,
          deleted_at     TEXT,
          purged_at      TEXT,
          PRIMARY KEY (owner, repo)
        )
      `);
    });
  }

  async upsert(owner: string, repo: string): Promise<RepoRow> {
    const now = isoNow();
    await this.db
      .insert(repos)
      .values({ owner, repo, firstSeen: now, updatedAt: now })
      .onConflictDoUpdate({
        target: [repos.owner, repos.repo],
        set: { updatedAt: now },
      });
    const [row] = await this.db.select().from(repos).where(byKey(owner, repo));
    return row;
  }

  async get(owner: string, repo: string): Promise<RepoRow | null> {
    const [row] = await this.db.select().from(repos).where(byKey(owner, repo));
    return row ?? null;
  }

  async listByStatus(status: RepoStatus): Promise<RepoRow[]> {
    return await this.db.select().from(repos).where(eq(repos.status, status));
  }

  async listAll(): Promise<RepoRow[]> {
    return await this.db.select().from(repos);
  }

  async markMissing(owner: string, repo: string): Promise<RepoRow | null> {
    const now = isoNow();
    const rows = await this.db
      .update(repos)
      .set({ status: "missing", missingAt: now, updatedAt: now })
      .where(and(byKey(owner, repo), eq(repos.status, "active")))
      .returning();
    return rows[0] ?? null;
  }

  async markActive(owner: string, repo: string): Promise<RepoRow | null> {
    const now = isoNow();
    const current = await this.get(owner, repo);
    if (!current) return null;
    if (current.status !== "missing" && current.status !== "deleted") {
      return null;
    }
    const rows = await this.db
      .update(repos)
      .set({
        status: "active",
        missingAt: null,
        deletedAt: null,
        updatedAt: now,
      })
      .where(byKey(owner, repo))
      .returning();
    return rows[0] ?? null;
  }

  async markDeleted(owner: string, repo: string): Promise<RepoRow | null> {
    const now = isoNow();
    const rows = await this.db
      .update(repos)
      .set({
        status: "deleted",
        deletedAt: now,
        updatedAt: now,
      })
      .where(and(byKey(owner, repo), eq(repos.status, "missing")))
      .returning();
    return rows[0] ?? null;
  }

  async markPurged(owner: string, repo: string): Promise<RepoRow | null> {
    const now = isoNow();
    const rows = await this.db
      .update(repos)
      .set({ status: "purged", purgedAt: now, updatedAt: now })
      .where(and(byKey(owner, repo), eq(repos.status, "deleted")))
      .returning();
    return rows[0] ?? null;
  }
}
