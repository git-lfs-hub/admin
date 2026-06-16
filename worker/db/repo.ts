import { DurableObject } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { drizzle, DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';

import { branches, lfsconfigs, type LfsconfigParseStatus } from '@/db/repo-schema';
import { isoNow } from '@/lib/time';

export type BranchRow = typeof branches.$inferSelect;
export type LfsconfigRow = typeof lfsconfigs.$inferSelect;

/** A parsed `.lfsconfig` blob (content-addressed by git `sha`), as written to the cache. */
export type LfsconfigParse = {
  sha: string;
  host: string;
  prefix: string;
  local: boolean;
  status: LfsconfigParseStatus;
};

/** Per-git-repo Durable Object (keyed `lc(owner/repo)` — the git identity). Holds per-branch
 *  `.lfsconfig` observations (`branches`) and the deduped parse cache (`lfsconfigs`). The scan
 *  itself (GitHub tree/blob fetch) lives in `github/lfsconfig.ts`; `syncLinks` lands in step 4. */
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

  /** Branch's `.lfsconfig` is absent at `headSha`: record `missing`, no blob row. */
  async recordMissing(branch: string, headSha: string): Promise<void> {
    const now = isoNow();
    await this.db
      .insert(branches)
      .values({ branch, headSha, seenAt: now, lfsconfigSha: null, lfsconfigStatus: 'missing' })
      .onConflictDoUpdate({
        target: branches.branch,
        set: { headSha, seenAt: now, lfsconfigSha: null, lfsconfigStatus: 'missing' },
      });
  }

  /** Persist a scanned blob: insert the parse cache row (no-op if the blob is already cached,
   *  content-addressed by `sha`) and upsert the branch's `.lfsconfig` columns to point at it. */
  async recordLfsconfig(branch: string, headSha: string, blob: LfsconfigParse): Promise<void> {
    const now = isoNow();
    await this.db
      .insert(lfsconfigs)
      .values({
        sha: blob.sha,
        host: blob.host,
        prefix: blob.prefix,
        local: blob.local,
        status: blob.status,
        parsedAt: now,
      })
      .onConflictDoNothing({ target: lfsconfigs.sha });
    await this.db
      .insert(branches)
      .values({
        branch,
        headSha,
        seenAt: now,
        lfsconfigSha: blob.sha,
        lfsconfigStatus: blob.status,
      })
      .onConflictDoUpdate({
        target: branches.branch,
        set: { headSha, seenAt: now, lfsconfigSha: blob.sha, lfsconfigStatus: blob.status },
      });
  }
}
