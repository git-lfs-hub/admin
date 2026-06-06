import { DurableObject } from "cloudflare:workers";
import { and, eq, inArray, ne, sql, type SQL } from "drizzle-orm";
import { drizzle, DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";

import { isoNow } from "@/lib/time";
import { repos, orgs, type RepoStatus, type OrgStatus } from "@/db/repos-schema";

export type RepoRow = typeof repos.$inferSelect;
export type OrgRow = typeof orgs.$inferSelect;

export type ReconciliationInput = {
  activeOrgs: Set<string>;
  activeRepos: Set<string>;
};

export type ReconciliationResult = {
  missing: RepoRow[];
  missingReappeared: RepoRow[];
  archivedReappeared: RepoRow[];
};

export class Repos extends DurableObject<CloudflareBindings> {
  private db: DrizzleSqliteDODatabase;

  constructor(ctx: DurableObjectState, env: CloudflareBindings) {
    super(ctx, env);
    this.db = drizzle(ctx.storage);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS repos (
          owner           TEXT NOT NULL,
          repo            TEXT NOT NULL,
          name            TEXT NOT NULL,
          status          TEXT NOT NULL DEFAULT 'active',
          first_seen      TEXT NOT NULL,
          updated_at      TEXT NOT NULL,
          missing_at      TEXT,
          archived_at     TEXT,
          backed_up_at    TEXT,
          backup_complete INTEGER NOT NULL DEFAULT 0,
          cleared_at      TEXT,
          purged_at       TEXT,
          active_op       TEXT,
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

  async listAll(): Promise<RepoRow[]> {
    return await this.db.select().from(repos);
  }

  async listByStatus(status: RepoStatus): Promise<RepoRow[]> {
    return await this.db.select().from(repos).where(eq(repos.status, status));
  }

  async listOwners(): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ owner: sql<string>`lower(${repos.owner})`.as("owner") })
      .from(repos)
      .where(ne(repos.status, "purged"));
    return rows.map((r) => r.owner);
  }

  async upsert(owner: string, repo: string): Promise<RepoRow> {
    const now = isoNow();
    const name = `${owner}/${repo}`;
    const [row] = await this.db
      .insert(repos)
      .values({
        owner: owner.toLowerCase(),
        repo: repo.toLowerCase(),
        name,
        firstSeen: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [repos.owner, repos.repo],
        set: { updatedAt: now },
      })
      .returning();
    return row;
  }

  async markMissing(owner: string, repo: string): Promise<RepoRow | null> {
    return this.updateStatus(
      owner,
      repo,
      setStatus("missing", isoNow()),
      eq(repos.status, "active"),
    );
  }

  async markActive(owner: string, repo: string): Promise<RepoRow | null> {
    const current = await this.get(owner, repo);
    if (!current || (current.status !== "missing" && current.status !== "archived")) {
      return null;
    }
    return this.updateStatus(owner, repo, setStatus("active", isoNow()));
  }

  async markArchived(owner: string, repo: string): Promise<RepoRow | null> {
    return this.updateStatus(
      owner,
      repo,
      setStatus("archived", isoNow()),
      eq(repos.status, "missing"),
    );
  }

  async markPurged(owner: string, repo: string): Promise<RepoRow | null> {
    return this.updateStatus(
      owner,
      repo,
      setStatus("purged", isoNow()),
      eq(repos.status, "archived"),
    );
  }

  async recordReconciliation(input: ReconciliationInput): Promise<ReconciliationResult> {
    const out: ReconciliationResult = { missing: [], missingReappeared: [], archivedReappeared: [] };
    if (input.activeOrgs.size === 0) return out;
    const now = isoNow();
    const activeOrgs = [...input.activeOrgs].map((o) => o.toLowerCase());
    const rows = await this.db
      .select()
      .from(repos)
      .where(and(ne(repos.status, "purged"), inArray(repos.owner, [...activeOrgs])));
    for (const r of rows) {
      if (input.activeRepos.has(repoKey(r.owner, r.repo))) {
        if (r.status === "missing") {
          const u = await this.updateStatus(r.owner, r.repo, setStatus("active", now));
          if (u) out.missingReappeared.push(u);
        } else if (r.status === "archived") {
          out.archivedReappeared.push(r);
        }
      } else if (r.status === "active") {
        const u = await this.updateStatus(r.owner, r.repo, setStatus("missing", now));
        if (u) out.missing.push(u);
      }
    }
    return out;
  }

  /** Update one repo by key (optionally guarded) and return the affected row (or null). */
  private async updateStatus(
    owner: string,
    repo: string,
    set: Partial<typeof repos.$inferInsert>,
    guard?: SQL,
  ): Promise<RepoRow | null> {
    const where = guard ? and(byKey(owner, repo), guard) : byKey(owner, repo);
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
      lastError: status === "active" ? null : (lastError ?? null),
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

const STATUS_FIELDS = {
  active: { clear: ["missingAt", "archivedAt"] },
  missing: { stamp: "missingAt" },
  archived: { stamp: "archivedAt" },
  purged: { stamp: "purgedAt" },
} as const satisfies Record<RepoStatus, { stamp?: keyof RepoRow; clear?: (keyof RepoRow)[] }>;

function setStatus(to: RepoStatus, now: string): Partial<typeof repos.$inferInsert> {
  const f = STATUS_FIELDS[to];
  return {
    status: to,
    updatedAt: now,
    ...("stamp" in f ? { [f.stamp]: now } : {}),
    ...("clear" in f ? Object.fromEntries(f.clear.map((k) => [k, null])) : {}),
  };
}

function byKey(owner: string, repo: string) {
  return and(eq(repos.owner, owner.toLowerCase()), eq(repos.repo, repo.toLowerCase()));
}

function repoKey(owner: string, repo: string) {
  return `${owner.toLowerCase()}/${repo.toLowerCase()}`;
}
