import { DurableObject } from "cloudflare:workers";
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle, DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";

import { isoNow } from "@/lib/time";
import {
  repos,
  orgs,
  type RepoStatus,
  type OrgStatus,
} from "@/db/_repos-schema";

export type RepoRow = typeof repos.$inferSelect;
export type OrgRow = typeof orgs.$inferSelect;

export type ReconciliationInput = {
  activeOrgs: Set<string>;
  activeRepos: Set<string>;
};

export type ReconciliationResult = {
  missing: RepoRow[];
  missingReappeared: RepoRow[];
  deletedReappeared: RepoRow[];
};

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
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS orgs (
          org         TEXT PRIMARY KEY,
          status      TEXT NOT NULL,
          first_seen  TEXT NOT NULL,
          updated_at  TEXT NOT NULL,
          missing_at  TEXT,
          last_error  TEXT
        )
      `);
    });
  }

  async upsert(owner: string, repo: string): Promise<RepoRow> {
    const o = owner.toLowerCase();
    const r = repo.toLowerCase();
    const now = isoNow();
    await this.db
      .insert(repos)
      .values({ owner: o, repo: r, firstSeen: now, updatedAt: now })
      .onConflictDoUpdate({
        target: [repos.owner, repos.repo],
        set: { updatedAt: now },
      });
    const [row] = await this.db.select().from(repos).where(byKey(o, r));
    return row;
  }

  async get(owner: string, repo: string): Promise<RepoRow | null> {
    const [row] = await this.db
      .select()
      .from(repos)
      .where(byKey(owner.toLowerCase(), repo.toLowerCase()));
    return row ?? null;
  }

  async listByStatus(status: RepoStatus): Promise<RepoRow[]> {
    return await this.db.select().from(repos).where(eq(repos.status, status));
  }

  async listAll(): Promise<RepoRow[]> {
    return await this.db.select().from(repos);
  }

  async listOwners(): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ owner: sql<string>`lower(${repos.owner})`.as("owner") })
      .from(repos)
      .where(inArray(repos.status, ["active", "missing", "deleted"]));
    return rows.map((r) => r.owner);
  }

  async markMissing(owner: string, repo: string): Promise<RepoRow | null> {
    const o = owner.toLowerCase();
    const r = repo.toLowerCase();
    const now = isoNow();
    const rows = await this.db
      .update(repos)
      .set({ status: "missing", missingAt: now, updatedAt: now })
      .where(and(byKey(o, r), eq(repos.status, "active")))
      .returning();
    return rows[0] ?? null;
  }

  async markActive(owner: string, repo: string): Promise<RepoRow | null> {
    const o = owner.toLowerCase();
    const r = repo.toLowerCase();
    const now = isoNow();
    const current = await this.get(o, r);
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
      .where(byKey(o, r))
      .returning();
    return rows[0] ?? null;
  }

  async markDeleted(owner: string, repo: string): Promise<RepoRow | null> {
    const o = owner.toLowerCase();
    const r = repo.toLowerCase();
    const now = isoNow();
    const rows = await this.db
      .update(repos)
      .set({
        status: "deleted",
        deletedAt: now,
        updatedAt: now,
      })
      .where(and(byKey(o, r), eq(repos.status, "missing")))
      .returning();
    return rows[0] ?? null;
  }

  async markPurged(owner: string, repo: string): Promise<RepoRow | null> {
    const o = owner.toLowerCase();
    const r = repo.toLowerCase();
    const now = isoNow();
    const rows = await this.db
      .update(repos)
      .set({ status: "purged", purgedAt: now, updatedAt: now })
      .where(and(byKey(o, r), eq(repos.status, "deleted")))
      .returning();
    return rows[0] ?? null;
  }

  async recordReconciliation(
    input: ReconciliationInput,
  ): Promise<ReconciliationResult> {
    const out: ReconciliationResult = {
      missing: [],
      missingReappeared: [],
      deletedReappeared: [],
    };
    if (input.activeOrgs.size === 0) return out;
    const activeOrgs = new Set<string>();
    for (const o of input.activeOrgs) activeOrgs.add(o.toLowerCase());

    const present = input.activeRepos;
    const all = await this.db.select().from(repos);
    const now = isoNow();
    for (const row of all) {
      const ownerLower = row.owner.toLowerCase();
      if (!activeOrgs.has(ownerLower)) continue;
      if (row.status === "purged") continue;
      const key = repoKey(row.owner, row.repo);
      const isPresent = present.has(key);
      if (row.status === "active" && !isPresent) {
        const [updated] = await this.db
          .update(repos)
          .set({ status: "missing", missingAt: now, updatedAt: now })
          .where(byKey(row.owner, row.repo))
          .returning();
        if (updated) out.missing.push(updated);
      } else if (row.status === "missing" && isPresent) {
        const [updated] = await this.db
          .update(repos)
          .set({
            status: "active",
            missingAt: null,
            updatedAt: now,
          })
          .where(byKey(row.owner, row.repo))
          .returning();
        if (updated) out.missingReappeared.push(updated);
      } else if (row.status === "deleted" && isPresent) {
        out.deletedReappeared.push(row);
      }
    }
    return out;
  }

  async upsertOrgStatus(
    org: string,
    status: OrgStatus,
    lastError?: string | null,
  ): Promise<OrgRow> {
    const key = org.toLowerCase();
    const now = isoNow();
    const [existing] = await this.db.select().from(orgs).where(eq(orgs.org, key));
    if (!existing) {
      const insertValues = {
        org: key,
        status,
        firstSeen: now,
        updatedAt: now,
        missingAt: status === "missing" ? now : null,
        lastError: lastError ?? null,
      };
      await this.db.insert(orgs).values(insertValues);
      const [row] = await this.db.select().from(orgs).where(eq(orgs.org, key));
      return row;
    }
    const next: Partial<OrgRow> = {
      status,
      updatedAt: now,
      lastError: status === "active" ? null : lastError ?? null,
    };
    if (status === "active") {
      next.missingAt = null;
    } else if (status === "missing") {
      next.missingAt = existing.missingAt ?? now;
    }
    await this.db.update(orgs).set(next).where(eq(orgs.org, key));
    const [row] = await this.db.select().from(orgs).where(eq(orgs.org, key));
    return row;
  }

  async listOrgs(): Promise<OrgRow[]> {
    return await this.db.select().from(orgs);
  }
}

function byKey(owner: string, repo: string) {
  return and(eq(repos.owner, owner), eq(repos.repo, repo));
}

function repoKey(owner: string, repo: string) {
  return `${owner.toLowerCase()}/${repo.toLowerCase()}`;
}
