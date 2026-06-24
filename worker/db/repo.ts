import { DurableObject } from 'cloudflare:workers';
import { and, count, eq, inArray, ne } from 'drizzle-orm';
import { drizzle, DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';

import { Registry } from '@/db/registry';
import {
  branches,
  gitattributes,
  lfsconfigs,
  lfsPointers,
  refPaths,
  type BranchStatus,
  type LfsconfigParseStatus,
} from '@/db/repo-schema';
import { isoNow } from '@/lib/time';

export type BranchRow = typeof branches.$inferSelect;
export type LfsconfigRow = typeof lfsconfigs.$inferSelect;
export type RefPath = { oid: string; path: string };
export type PointerRow = typeof lfsPointers.$inferSelect;

/** A branch row joined to its resolved `.lfsconfig` (the storage prefix it links to) and its
 *  referenced-OID count — the per-repo branch drilldown payload. `lfsconfig` is null when the
 *  branch has no parsed config. */
export type BranchSummary = BranchRow & {
  lfsconfig: { prefix: string; local: boolean; host: string } | null;
  oidCount: number;
};

/** CF Durable Object SQLite caps bound parameters per statement at 100. */
const SQL_VAR_LIMIT = 100;

/** Full git ref for a branch row (`ref_paths.ref` is the full ref, shared with tags). */
export function branchRef(branch: string): string {
  return `refs/heads/${branch}`;
}

/** A parsed `.lfsconfig` blob (content-addressed by git `sha`), as written to the cache. */
export type LfsConfig = {
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
          lfsconfig_status  TEXT,
          status            TEXT NOT NULL DEFAULT 'active',
          tree_sha          TEXT,
          dirty             INTEGER NOT NULL DEFAULT 0,
          gitattr_sha       TEXT,
          scanned_at        TEXT,
          missing_at        TEXT,
          deleted_at        TEXT
        )
      `);
      // Backfill lifecycle columns on an existing branches table (idempotent).
      for (const col of [
        `status TEXT NOT NULL DEFAULT 'active'`,
        `tree_sha TEXT`,
        `dirty INTEGER NOT NULL DEFAULT 0`,
        `gitattr_sha TEXT`,
        `scanned_at TEXT`,
        `missing_at TEXT`,
        `deleted_at TEXT`,
      ]) {
        try {
          this.ctx.storage.sql.exec(`ALTER TABLE branches ADD COLUMN ${col}`);
        } catch {
          // column already present
        }
      }
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS ref_paths (
          oid  TEXT NOT NULL,
          ref  TEXT NOT NULL,
          path TEXT NOT NULL,
          PRIMARY KEY (oid, ref, path)
        )
      `);
      this.ctx.storage.sql.exec(`CREATE INDEX IF NOT EXISTS idx_ref_paths_oid ON ref_paths (oid)`);
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS lfs_pointers (
          sha  TEXT PRIMARY KEY,
          oid  TEXT,
          size INTEGER
        )
      `);
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS gitattributes (
          sha     TEXT PRIMARY KEY,
          content TEXT NOT NULL
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

  /** Per-repo branch drilldown: every branch joined to its resolved `.lfsconfig` + its
   *  referenced-OID count. */
  async branchSummaries(): Promise<BranchSummary[]> {
    const rows = await this.db
      .select()
      .from(branches)
      .leftJoin(lfsconfigs, eq(branches.lfsconfigSha, lfsconfigs.sha));
    const counts = await this.db
      .select({ ref: refPaths.ref, n: count() })
      .from(refPaths)
      .groupBy(refPaths.ref);
    const byRef = new Map(counts.map((c) => [c.ref, c.n]));
    return rows.map(({ branches: b, lfsconfigs: cfg }) => ({
      ...b,
      lfsconfig: cfg ? { prefix: cfg.prefix, local: cfg.local, host: cfg.host } : null,
      oidCount: byRef.get(branchRef(b.branch)) ?? 0,
    }));
  }

  /** The local storage prefix a branch's `.lfsconfig` points at (`local`, parsed `ok`), or null —
   *  the confirm/undelete gate (external or unparsed configs have no prefix to recompute). */
  async localPrefixForBranch(branch: string): Promise<string | null> {
    const [row] = await this.db
      .select({ prefix: lfsconfigs.prefix, local: lfsconfigs.local, status: lfsconfigs.status })
      .from(branches)
      .innerJoin(lfsconfigs, eq(branches.lfsconfigSha, lfsconfigs.sha))
      .where(eq(branches.branch, branch));
    return row && row.local && row.status === 'ok' ? row.prefix : null;
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
  async recordLfsconfig(branch: string, headSha: string, blob: LfsConfig): Promise<void> {
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

  // --- branch lifecycle + tip state ---

  /** Record a new tip whose `ref_paths` can't be trusted (diverged / oversized / first sight gap):
   *  advance `head_sha`, flag `dirty`, leave `tree_sha`/`ref_paths` for `resolveBranch`. */
  async markDirty(branch: string, headSha: string): Promise<void> {
    const now = isoNow();
    await this.db
      .insert(branches)
      .values({ branch, headSha, seenAt: now, dirty: true, status: 'active' })
      .onConflictDoUpdate({
        target: branches.branch,
        set: { headSha, seenAt: now, dirty: true, status: 'active' },
      });
  }

  /** Advance a branch to a consistent tip (after a sequential delta or full resolve): set
   *  `head_sha`/`tree_sha`/`gitattr_sha`, stamp `scanned_at`, clear `dirty`, status `active`. */
  async setTip(
    branch: string,
    tip: { headSha: string; treeSha: string; gitattrSha: string | null },
  ): Promise<void> {
    const now = isoNow();
    const set = {
      headSha: tip.headSha,
      treeSha: tip.treeSha,
      gitattrSha: tip.gitattrSha,
      scannedAt: now,
      seenAt: now,
      dirty: false,
      status: 'active' as const,
    };
    await this.db
      .insert(branches)
      .values({ branch, ...set })
      .onConflictDoUpdate({ target: branches.branch, set });
  }

  /** Branch ref deleted on GitHub: flag `missing` (admin confirms forfeiture separately). */
  async markBranchMissing(branch: string): Promise<void> {
    await this.db
      .update(branches)
      .set({ status: 'missing', missingAt: isoNow() })
      .where(eq(branches.branch, branch));
  }

  /** Branch ref reappeared while `missing`: back to `active`, clear `missing_at`. */
  async markBranchActive(branch: string): Promise<void> {
    await this.db
      .update(branches)
      .set({ status: 'active', missingAt: null })
      .where(eq(branches.branch, branch));
  }

  /** Admin confirmed branch deletion: forfeit its references. Stamps `deleted_at`; returns the row
   *  (null if the branch is gone or already `deleted`). Caller recomputes the prefix block set. */
  async markBranchDeleted(branch: string): Promise<BranchRow | null> {
    const [row] = await this.db
      .update(branches)
      .set({ status: 'deleted', deletedAt: isoNow() })
      .where(and(eq(branches.branch, branch), ne(branches.status, 'deleted')))
      .returning();
    return row ?? null;
  }

  /** Undelete: reverse a confirmed delete. Back to `missing` if the ref was gone from GitHub when
   *  deleted (its `missing_at` survived), else `active`. Clears `deleted_at`; returns the row
   *  (null unless it was `deleted`). */
  async undeleteBranch(branch: string): Promise<BranchRow | null> {
    const cur = await this.getBranch(branch);
    if (!cur || cur.status !== 'deleted') return null;
    const status = cur.missingAt ? 'missing' : 'active';
    const [row] = await this.db
      .update(branches)
      .set({ status, deletedAt: null })
      .where(eq(branches.branch, branch))
      .returning();
    return row ?? null;
  }

  /** A clean sibling branch already resolved at `treeSha` (for the 0-call copy short-circuit). */
  async cleanBranchAtTree(treeSha: string, exclude: string): Promise<string | null> {
    const [row] = await this.db
      .select({ branch: branches.branch })
      .from(branches)
      .where(
        and(eq(branches.treeSha, treeSha), eq(branches.dirty, false), ne(branches.branch, exclude)),
      )
      .limit(1);
    return row?.branch ?? null;
  }

  // --- ref_paths ---

  async listRefPaths(branch: string): Promise<RefPath[]> {
    return await this.db
      .select({ oid: refPaths.oid, path: refPaths.path })
      .from(refPaths)
      .where(eq(refPaths.ref, branchRef(branch)));
  }

  /** Replace a branch's `ref_paths` wholesale (full resolve). Never call with a *partial* tree —
   *  a partial replace silently drops live OIDs → wrongful purge. */
  async replaceRefPaths(branch: string, paths: RefPath[]): Promise<void> {
    const ref = branchRef(branch);
    await this.db.delete(refPaths).where(eq(refPaths.ref, ref));
    await this.insertRefPaths(ref, paths);
  }

  /** Apply a commit delta: drop rows at `removePaths`, upsert `add` rows (idempotent on PK). */
  async applyRefPathsDelta(branch: string, add: RefPath[], removePaths: string[]): Promise<void> {
    const ref = branchRef(branch);
    for (let i = 0; i < removePaths.length; i += SQL_VAR_LIMIT - 1) {
      const chunk = removePaths.slice(i, i + SQL_VAR_LIMIT - 1);
      await this.db
        .delete(refPaths)
        .where(and(eq(refPaths.ref, ref), inArray(refPaths.path, chunk)));
    }
    await this.insertRefPaths(ref, add);
  }

  /** Copy a sibling's `ref_paths` onto this branch (same `tree_sha`, 0 GitHub calls). */
  async copyRefPaths(from: string, to: string): Promise<void> {
    const src = await this.listRefPaths(from);
    await this.replaceRefPaths(to, src);
  }

  private async insertRefPaths(ref: string, paths: RefPath[]): Promise<void> {
    const rows = paths.map((p) => ({ oid: p.oid, ref, path: p.path }));
    const perBatch = Math.floor(SQL_VAR_LIMIT / 3);
    for (let i = 0; i < rows.length; i += perBatch) {
      await this.db
        .insert(refPaths)
        .values(rows.slice(i, i + perBatch))
        .onConflictDoNothing();
    }
  }

  // --- content-addressed caches (lfs_pointers, gitattributes) ---

  /** Cached pointer parses for the given blob shas (hits only; misses are absent from the map).
   *  A row with `oid = null` is a negative cache entry (matched `.gitattributes`, not a pointer). */
  async getPointers(blobShas: string[]): Promise<Map<string, PointerRow>> {
    const out = new Map<string, PointerRow>();
    for (let i = 0; i < blobShas.length; i += SQL_VAR_LIMIT) {
      const chunk = blobShas.slice(i, i + SQL_VAR_LIMIT);
      const rows = await this.db.select().from(lfsPointers).where(inArray(lfsPointers.sha, chunk));
      for (const r of rows) out.set(r.sha, r);
    }
    return out;
  }

  async putPointers(rows: PointerRow[]): Promise<void> {
    const perBatch = Math.floor(SQL_VAR_LIMIT / 3);
    for (let i = 0; i < rows.length; i += perBatch) {
      await this.db
        .insert(lfsPointers)
        .values(rows.slice(i, i + perBatch))
        .onConflictDoNothing();
    }
  }

  async getGitattributes(blobSha: string): Promise<string | null> {
    const [row] = await this.db
      .select({ content: gitattributes.content })
      .from(gitattributes)
      .where(eq(gitattributes.sha, blobSha));
    return row?.content ?? null;
  }

  async putGitattributes(blobSha: string, content: string): Promise<void> {
    await this.db
      .insert(gitattributes)
      .values({ sha: blobSha, content })
      .onConflictDoNothing({ target: gitattributes.sha });
  }

  // Writes links only, never `storage` rows: a `.lfsconfig` claim is a link, not bytes (storage
  // comes from R2 discovery / object-writes). Dropped prefixes go `stale`.
  async syncLinks(owner: string, repo: string): Promise<void> {
    const registry = Registry.global(this.env);
    await registry.syncLinks(owner, repo, await this.localPrefixes());
  }

  /** Effective block set for a prefix: OIDs some `deleted` branch (linked to this prefix) references
   *  and no `active`/`missing` branch (same prefix) still references. The block/purge unit — every
   *  object on a prefix may be referenced from many branches, so a delete blocks only the orphans. */
  async blockedOidsForPrefix(prefix: string): Promise<string[]> {
    const deletedRefs = await this.refsForPrefix(prefix, ['deleted']);
    if (deletedRefs.length === 0) return [];
    const liveRefs = await this.refsForPrefix(prefix, ['active', 'missing']);
    const deletedOids = await this.oidsForRefs(deletedRefs);
    const liveOids = await this.oidsForRefs(liveRefs);
    return [...deletedOids].filter((oid) => !liveOids.has(oid));
  }

  /** Full refs of branches in any of `statuses` whose local `.lfsconfig` points at `prefix`. */
  private async refsForPrefix(prefix: string, statuses: BranchStatus[]): Promise<string[]> {
    const rows = await this.db
      .select({ branch: branches.branch })
      .from(branches)
      .innerJoin(lfsconfigs, eq(branches.lfsconfigSha, lfsconfigs.sha))
      .where(
        and(
          eq(lfsconfigs.prefix, prefix),
          eq(lfsconfigs.local, true),
          eq(lfsconfigs.status, 'ok'),
          inArray(branches.status, statuses),
        ),
      );
    return rows.map((r) => branchRef(r.branch));
  }

  /** Distinct OIDs referenced by any of the given refs. */
  private async oidsForRefs(refs: string[]): Promise<Set<string>> {
    const out = new Set<string>();
    for (let i = 0; i < refs.length; i += SQL_VAR_LIMIT) {
      const chunk = refs.slice(i, i + SQL_VAR_LIMIT);
      const rows = await this.db
        .selectDistinct({ oid: refPaths.oid })
        .from(refPaths)
        .where(inArray(refPaths.ref, chunk));
      for (const r of rows) out.add(r.oid);
    }
    return out;
  }

  /** Distinct local storage prefixes this repo currently references (`local`, parsed `ok`),
   *  across all recorded branches. */
  private async localPrefixes(): Promise<Set<string>> {
    const rows = await this.db
      .selectDistinct({ prefix: lfsconfigs.prefix })
      .from(branches)
      .innerJoin(lfsconfigs, eq(branches.lfsconfigSha, lfsconfigs.sha))
      .where(and(eq(lfsconfigs.local, true), eq(lfsconfigs.status, 'ok')));
    return new Set(rows.map((r) => r.prefix));
  }
}
