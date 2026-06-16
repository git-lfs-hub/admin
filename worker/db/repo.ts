import { DurableObject } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { drizzle, DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';

import { branches, lfsconfigs } from '@/db/repo-schema';

export type BranchRow = typeof branches.$inferSelect;
export type LfsconfigRow = typeof lfsconfigs.$inferSelect;

/** Per-git-repo Durable Object (keyed `lc(owner/repo)` — the git identity). Holds per-branch
 *  `.lfsconfig` observations (`branches`) and the deduped parse cache (`lfsconfigs`).
 *  `scanLfsconfig` / `syncLinks` land in later Phase 1.5 steps. */
export class Repo extends DurableObject<CloudflareBindings> {
  private db: DrizzleSqliteDODatabase;

  static byRepo(env: CloudflareBindings, owner: string, repo: string): DurableObjectStub<Repo> {
    return env.REPO.getByName(`${owner.toLowerCase()}/${repo.toLowerCase()}`);
  }

  constructor(ctx: DurableObjectState, env: CloudflareBindings) {
    super(ctx, env);
    this.db = drizzle(ctx.storage);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS branches (
          branch            TEXT PRIMARY KEY,
          head_sha          TEXT NOT NULL,
          seen_at           TEXT NOT NULL,
          lfsconfig_sha     TEXT,
          lfsconfig_status  TEXT
        )
      `);
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS lfsconfigs (
          sha       TEXT PRIMARY KEY,
          host      TEXT NOT NULL,
          prefix    TEXT NOT NULL,
          local     INTEGER NOT NULL,
          status    TEXT NOT NULL,
          parsed_at TEXT NOT NULL
        )
      `);
    });
  }

  async listBranches(): Promise<BranchRow[]> {
    return await this.db.select().from(branches);
  }

  async getBranch(branch: string): Promise<BranchRow | null> {
    const [row] = await this.db.select().from(branches).where(eq(branches.branch, branch));
    return row ?? null;
  }

  async listLfsconfigs(): Promise<LfsconfigRow[]> {
    return await this.db.select().from(lfsconfigs);
  }
}
