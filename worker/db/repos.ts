import { DurableObject } from "cloudflare:workers";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
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

  async listOwners(): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ owner: sql<string>`lower(${repos.owner})`.as("owner") })
      .from(repos)
      .where(inArray(repos.status, ["active", "missing", "deleted"]));
    return rows.map((r) => r.owner);
  }

  async upsert(owner: string, repo: string): Promise<RepoRow> {
    const now = isoNow();
    const [row] = await this.db
      .insert(repos)
      .values({
        owner: owner.toLowerCase(),
        repo: repo.toLowerCase(),
        firstSeen: now,
        updatedAt: now
      })
      .onConflictDoUpdate({
        target: [repos.owner, repos.repo],
        set: { updatedAt: now },
      })
      .returning();
    return row;
  }

  async markMissing(owner: string, repo: string): Promise<RepoRow | null> {
    const now = isoNow();
    return this.updateStatus(and(byKey(owner, repo), eq(repos.status, "active")), {
      status: "missing",
      missingAt: now,
      updatedAt: now,
    });
  }

  async markActive(owner: string, repo: string): Promise<RepoRow | null> {
    const now = isoNow();
    const current = await this.get(owner, repo);
    if (!current || current.status !== "missing" && current.status !== "deleted") {
      return null;
    }
    return this.updateStatus(byKey(owner, repo), {
      status: "active",
      missingAt: null,
      deletedAt: null,
      updatedAt: now,
    });
  }

  async markDeleted(owner: string, repo: string): Promise<RepoRow | null> {
    const now = isoNow();
    return this.updateStatus(and(byKey(owner, repo), eq(repos.status, "missing")), {
      status: "deleted",
      deletedAt: now,
      updatedAt: now,
    });
  }

  async markPurged(owner: string, repo: string): Promise<RepoRow | null> {
    const now = isoNow();
    return this.updateStatus(and(byKey(owner, repo), eq(repos.status, "deleted")), {
      status: "purged",
      purgedAt: now,
      updatedAt: now,
    });
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

    const active = input.activeRepos;
    const now = isoNow();
    for (const row of await this.db.select().from(repos)) {
      if (!activeOrgs.has(row.owner.toLowerCase())) continue;
      if (row.status === "purged") continue;
      const key = repoKey(row.owner, row.repo);
      const isActive = active.has(key);
      if (row.status === "active" && !isActive) {
        const updated = await this.updateStatus(byKey(row.owner, row.repo), {
          status: "missing",
          missingAt: now,
          updatedAt: now,
        });
        if (updated) out.missing.push(updated);
      } else if (row.status === "missing" && isActive) {
        const updated = await this.updateStatus(byKey(row.owner, row.repo), {
          status: "active",
          missingAt: null,
          updatedAt: now,
        });
        if (updated) out.missingReappeared.push(updated);
      } else if (row.status === "deleted" && isActive) {
        out.deletedReappeared.push(row);
      }
    }
    return out;
  }

  /** Update matching repos and return the single affected row (or null). */
  private async updateStatus(
    where: SQL | undefined,
    set: Partial<typeof repos.$inferInsert>,
  ): Promise<RepoRow | null> {
    const rows = await this.db.update(repos).set(set).where(where).returning();
    return rows[0] ?? null;
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
  return and(
    eq(repos.owner, owner.toLowerCase()),
    eq(repos.repo, repo.toLowerCase()),
  );
}

function repoKey(owner: string, repo: string) {
  return `${owner.toLowerCase()}/${repo.toLowerCase()}`;
}
