import { DurableObject } from 'cloudflare:workers';
import { and, eq, inArray, isNotNull, isNull, ne, sql, type SQL } from 'drizzle-orm';
import { drizzle, DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';

import {
  repos,
  storage,
  orgs,
  meta,
  type RepoStatus,
  type StorageStatus,
  type OrgStatus,
} from '@/db/registry-schema';
import { isoNow } from '@/lib/time';

export type RepoRow = typeof repos.$inferSelect;
export type StorageRow = typeof storage.$inferSelect;
export type OrgRow = typeof orgs.$inferSelect;

export type ReconciliationInput = {
  activeOrgs: Set<string>; // lowercased org logins
  activeRepos: Set<string>; // lowercased `owner/repo` git keys
};

export type ReconciliationResult = {
  missing: RepoRow[]; // active → missing (gone from GitHub)
  reappeared: RepoRow[]; // missing → active (presence restored)
};

export type StorageReconciliationResult = {
  becameUnused: StorageRow[];
  becameUsed: StorageRow[];
  // used again but still blocked — caller unblocks (clearedAt null) or alerts (clearedAt set).
  blockedReused: StorageRow[];
};

/**
 * Singleton registry DO (`getByName("global")`). Three tables: `repos` (git presence),
 * `storage` (prefix lifecycle), `orgs` (reconciliation state). The git↔storage edge is not
 * stored — it is resolved 1:1 by same-key lookup `lc(prefix) ⇔ lc(owner/repo)`.
 */
export class Registry extends DurableObject<CloudflareBindings> {
  private db: DrizzleSqliteDODatabase;

  static global(env: CloudflareBindings): DurableObjectStub<Registry> {
    return env.REGISTRY.getByName('global');
  }

  constructor(ctx: DurableObjectState, env: CloudflareBindings) {
    super(ctx, env);
    this.db = drizzle(ctx.storage);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS repos (
          owner       TEXT NOT NULL,
          repo        TEXT NOT NULL,
          name        TEXT NOT NULL,
          status      TEXT NOT NULL DEFAULT 'active',
          first_seen  TEXT NOT NULL,
          updated_at  TEXT NOT NULL,
          missing_at  TEXT,
          PRIMARY KEY (owner, repo)
        )
      `);
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS storage (
          prefix          TEXT PRIMARY KEY,
          status          TEXT NOT NULL DEFAULT 'used',
          first_seen      TEXT NOT NULL,
          updated_at      TEXT NOT NULL,
          last_change_at  TEXT,
          unused_at       TEXT,
          archived_at     TEXT,
          backed_up_at    TEXT,
          backup_complete INTEGER NOT NULL DEFAULT 0,
          cleared_at      TEXT,
          purged_at       TEXT,
          active_op       TEXT
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
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS meta (
          id                 INTEGER PRIMARY KEY,
          last_full_scan_at  TEXT
        )
      `);
    });
  }

  // --- live updates: push a tick to every connected admin SPA on each storage write ---

  // Hibernatable WebSocket: the SPA opens `/api/live` (proxied to this DO). Push-only — we never
  // read from the socket, so no message/close handlers are needed (the runtime drops closed
  // sockets from `getWebSockets()`), and it survives DO hibernation between writes.
  override async fetch(req: Request): Promise<Response> {
    if (req.headers.get('upgrade') !== 'websocket')
      return new Response('expected websocket', { status: 426 });
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  // Wake every connected client to refetch the named topic ('storage' | 'repos'). Called after a
  // row in that table actually changes; the SPA filters by topic (one socket sees both).
  private broadcast(topic: 'storage' | 'repos'): void {
    for (const ws of this.ctx.getWebSockets()) ws.send(topic);
  }

  // --- repos: GitHub presence (git identity) ---

  async getRepo(owner: string, repo: string): Promise<RepoRow | null> {
    const [row] = await this.db.select().from(repos).where(repoKeyWhere(owner, repo));
    return row ?? null;
  }

  async listRepos(): Promise<RepoRow[]> {
    return await this.db.select().from(repos);
  }

  async upsertRepo(owner: string, repo: string, name?: string): Promise<RepoRow> {
    const now = isoNow();
    const existed = await this.getRepo(owner, repo);
    const [row] = await this.db
      .insert(repos)
      .values({
        owner: owner.toLowerCase(),
        repo: repo.toLowerCase(),
        name: name ?? `${owner}/${repo}`,
        status: 'active',
        firstSeen: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({ target: [repos.owner, repos.repo], set: { updatedAt: now } })
      .returning();
    // New repo discovered → tell clients; a re-upsert only bumps `updatedAt` (not shown), stay quiet.
    if (!existed) this.broadcast('repos');
    return row;
  }

  /**
   * Reconcile the `repos` table (git truth) against an org listing: upsert every active repo
   * (creating rows for newly-listed repos, flipping `missing`→`active`), and mark `missing`
   * any tracked repo in an active org absent from the listing.
   */
  async recordReconciliation(input: ReconciliationInput): Promise<ReconciliationResult> {
    const out: ReconciliationResult = { missing: [], reappeared: [] };
    if (input.activeOrgs.size === 0) return out;
    const activeOrgs = [...input.activeOrgs].map((o) => o.toLowerCase());

    for (const key of input.activeRepos) {
      const [owner, repo] = key.split('/');
      if (!activeOrgs.includes(owner.toLowerCase())) continue;
      const existing = await this.getRepo(owner, repo);
      await this.upsertRepo(owner, repo);
      if (existing?.status === 'missing') {
        const flipped = await this.markActive(owner, repo);
        if (flipped) out.reappeared.push(flipped);
      }
    }

    const tracked = await this.db
      .select()
      .from(repos)
      .where(and(eq(repos.status, 'active'), inArray(repos.owner, activeOrgs)));
    for (const r of tracked) {
      if (input.activeRepos.has(repoKey(r.owner, r.repo))) continue;
      const flipped = await this.markMissing(r.owner, r.repo);
      if (flipped) out.missing.push(flipped);
    }
    return out;
  }

  /** Per-repo analogue of `recordReconciliation` for a webhook event (idempotent). Untracked
   *  repos are created on a present event, ignored on an absent one. */
  async applyRepoEvent(
    owner: string,
    repo: string,
    present: boolean,
  ): Promise<{ row: RepoRow; reappeared: boolean } | null> {
    const existing = await this.getRepo(owner, repo);
    if (present) {
      const row = await this.upsertRepo(owner, repo);
      const flipped = existing?.status === 'missing' ? await this.markActive(owner, repo) : null;
      return { row: flipped ?? row, reappeared: flipped !== null };
    }
    if (!existing) return null;
    const flipped = await this.markMissing(owner, repo);
    return flipped ? { row: flipped, reappeared: false } : null;
  }

  async markMissing(owner: string, repo: string): Promise<RepoRow | null> {
    const now = isoNow();
    return this.updateRepo(
      owner,
      repo,
      { status: 'missing', missingAt: now, updatedAt: now },
      eq(repos.status, 'active'),
    );
  }

  async markActive(owner: string, repo: string): Promise<RepoRow | null> {
    const now = isoNow();
    return this.updateRepo(
      owner,
      repo,
      { status: 'active', missingAt: null, updatedAt: now },
      eq(repos.status, 'missing'),
    );
  }

  private async updateRepo(
    owner: string,
    repo: string,
    set: Partial<typeof repos.$inferInsert>,
    guard?: SQL,
  ): Promise<RepoRow | null> {
    const key = repoKeyWhere(owner, repo);
    const rows = await this.db
      .update(repos)
      .set(set)
      .where(guard ? and(key, guard) : key)
      .returning();
    if (rows[0]) this.broadcast('repos');
    return rows[0] ?? null;
  }

  // --- storage: prefix lifecycle ---

  async getStorage(prefix: string): Promise<StorageRow | null> {
    const [row] = await this.db.select().from(storage).where(eq(storage.prefix, prefix));
    return row ?? null;
  }

  async listStorage(): Promise<StorageRow[]> {
    return await this.db.select().from(storage);
  }

  async listStorageByStatus(status: StorageStatus): Promise<StorageRow[]> {
    return await this.db.select().from(storage).where(eq(storage.status, status));
  }

  async upsertStorage(prefix: string): Promise<StorageRow> {
    const now = isoNow();
    const existed = await this.getStorage(prefix);
    const [row] = await this.db
      .insert(storage)
      .values({ prefix, firstSeen: now, updatedAt: now })
      .onConflictDoUpdate({ target: storage.prefix, set: { updatedAt: now } })
      .returning();
    // New prefix discovered → tell clients; a re-upsert only bumps `updatedAt`, which the table
    // doesn't show, so stay quiet to avoid churn each reconcile tick.
    if (!existed) this.broadcast('storage');
    return row;
  }

  /** Serve-block, orthogonal to status; refused if already blocked or purged. */
  async block(prefix: string): Promise<StorageRow | null> {
    const now = isoNow();
    return this.updateStorage(
      prefix,
      { archivedAt: now, updatedAt: now },
      and(isNull(storage.archivedAt), ne(storage.status, 'purged')),
    );
  }

  /** Clear the serve-block, orthogonal to status. */
  async unblock(prefix: string): Promise<StorageRow | null> {
    return this.updateStorage(
      prefix,
      { archivedAt: null, updatedAt: isoNow() },
      isNotNull(storage.archivedAt),
    );
  }

  /** Link state, orthogonal to the block flag. */
  async markUsed(prefix: string): Promise<StorageRow | null> {
    const now = isoNow();
    return this.updateStorage(prefix, { status: 'used', unusedAt: null, updatedAt: now });
  }

  async markUnused(prefix: string): Promise<StorageRow | null> {
    const now = isoNow();
    return this.updateStorage(prefix, { status: 'unused', unusedAt: now, updatedAt: now });
  }

  /** Purge: only a blocked prefix is purgeable. */
  async markPurged(prefix: string): Promise<StorageRow | null> {
    const now = isoNow();
    return this.updateStorage(
      prefix,
      { status: 'purged', purgedAt: now, updatedAt: now },
      isNotNull(storage.archivedAt),
    );
  }

  private async updateStorage(
    prefix: string,
    set: Partial<typeof storage.$inferInsert>,
    guard?: SQL,
  ): Promise<StorageRow | null> {
    const key = eq(storage.prefix, prefix);
    const rows = await this.db
      .update(storage)
      .set(set)
      .where(guard ? and(key, guard) : key)
      .returning();
    if (rows[0]) this.broadcast('storage');
    return rows[0] ?? null;
  }

  /**
   * Reconcile every non-purged prefix's link state against the `repos` table (same-key match):
   * a prefix is `used` while its matching git repo is `active`, `unused` otherwise. Returns the
   * flips, plus `blockedReused` (became used but still blocked) for the caller to unblock/alert.
   */
  async reconcileStorage(): Promise<StorageReconciliationResult> {
    const out: StorageReconciliationResult = {
      becameUnused: [],
      becameUsed: [],
      blockedReused: [],
    };
    const active = await this.activeRepoKeys();
    const rows = await this.db.select().from(storage).where(ne(storage.status, 'purged'));
    for (const row of rows) {
      await this.applyLinkState(row, active.has(prefixKey(row.prefix)), out);
    }
    return out;
  }

  /** Single-prefix link reconcile for a webhook event. */
  async reconcileStoragePrefix(prefix: string): Promise<StorageReconciliationResult> {
    const out: StorageReconciliationResult = {
      becameUnused: [],
      becameUsed: [],
      blockedReused: [],
    };
    const row = await this.getStorage(prefix);
    if (!row || row.status === 'purged') return out;
    const active = await this.activeRepoKeys();
    await this.applyLinkState(row, active.has(prefixKey(prefix)), out);
    return out;
  }

  private async applyLinkState(
    row: StorageRow,
    linked: boolean,
    out: StorageReconciliationResult,
  ): Promise<void> {
    if (linked) {
      if (row.status === 'unused') {
        const flipped = await this.markUsed(row.prefix);
        if (flipped) {
          out.becameUsed.push(flipped);
          if (flipped.archivedAt) out.blockedReused.push(flipped);
        }
      } else if (row.archivedAt) {
        // already `used` but still blocked — surface so a stuck block self-heals.
        out.blockedReused.push(row);
      }
    } else if (row.status === 'used') {
      const flipped = await this.markUnused(row.prefix);
      if (flipped) out.becameUnused.push(flipped);
    }
  }

  /** Set of `lc(owner)/lc(repo)` for every `active` git repo (the link source). */
  private async activeRepoKeys(): Promise<Set<string>> {
    const rows = await this.db
      .select({ owner: repos.owner, repo: repos.repo })
      .from(repos)
      .where(eq(repos.status, 'active'));
    return new Set(rows.map((r) => repoKey(r.owner, r.repo)));
  }

  /** Same-key edge: the git repo for a prefix, if its matching `repos` row exists. */
  async repoForPrefix(prefix: string): Promise<RepoRow | null> {
    const [owner, repo] = prefix.split('/');
    if (!owner || !repo) return null;
    return this.getRepo(owner, repo);
  }

  /** The storage prefix for a git repo, if discovered (same-key match, case-insensitive). */
  async storageForRepo(owner: string, repo: string): Promise<StorageRow | null> {
    const key = repoKey(owner, repo);
    const [row] = await this.db
      .select()
      .from(storage)
      .where(eq(sql`lower(${storage.prefix})`, key));
    return row ?? null;
  }

  /** Purge gate: a prefix is in use while its matching git repo is `active`. */
  async storageInUse(prefix: string): Promise<boolean> {
    const repo = await this.repoForPrefix(prefix);
    return repo?.status === 'active';
  }

  /** Called cross-DO by the STORAGE DO `beginOp` to denormalize the in-flight op. */
  async setActiveOp(prefix: string, op: string | null): Promise<void> {
    await this.updateStorage(prefix, { activeOp: op, updatedAt: isoNow() });
  }

  /** Called cross-DO by the STORAGE DO `endOp` to land the resting status. */
  async endStorageOp(prefix: string, restingStatus: StorageStatus): Promise<void> {
    const now = isoNow();
    await this.updateStorage(prefix, {
      status: restingStatus,
      activeOp: null,
      updatedAt: now,
      ...(restingStatus === 'purged' ? { purgedAt: now } : {}),
    });
  }

  /** Bump `lastChangeAt` + reset `backupComplete` on an upload event (cold copy may have diverged). */
  async recordUpload(prefix: string): Promise<void> {
    const now = isoNow();
    await this.updateStorage(prefix, {
      lastChangeAt: now,
      backupComplete: false,
      updatedAt: now,
    });
  }

  // --- orgs ---

  async upsertOrgStatus(
    org: string,
    status: OrgStatus,
    lastError?: string | null,
  ): Promise<OrgRow> {
    const key = org.toLowerCase();
    const now = isoNow();
    const [existing] = await this.db.select().from(orgs).where(eq(orgs.org, key));
    if (!existing) {
      await this.db.insert(orgs).values({
        org: key,
        status,
        firstSeen: now,
        updatedAt: now,
        missingAt: status === 'missing' ? now : null,
        lastError: lastError ?? null,
      });
      const [row] = await this.db.select().from(orgs).where(eq(orgs.org, key));
      return row;
    }
    const next: Partial<OrgRow> = {
      status,
      updatedAt: now,
      lastError: status === 'active' ? null : (lastError ?? null),
    };
    if (status === 'active') {
      next.missingAt = null;
    } else if (status === 'missing') {
      next.missingAt = existing.missingAt ?? now;
    }
    await this.db.update(orgs).set(next).where(eq(orgs.org, key));
    const [row] = await this.db.select().from(orgs).where(eq(orgs.org, key));
    return row;
  }

  async listOrgs(): Promise<OrgRow[]> {
    return await this.db.select().from(orgs);
  }

  // --- cold-start guard ---

  /** null until the first trustworthy full reconcile pass — the archive/purge eligibility gate. */
  async getLastFullScanAt(): Promise<string | null> {
    const [row] = await this.db.select().from(meta).where(eq(meta.id, 1));
    return row?.lastFullScanAt ?? null;
  }

  async markFullScan(): Promise<void> {
    const now = isoNow();
    await this.db
      .insert(meta)
      .values({ id: 1, lastFullScanAt: now })
      .onConflictDoUpdate({ target: meta.id, set: { lastFullScanAt: now } });
  }
}

function repoKeyWhere(owner: string, repo: string) {
  return and(eq(repos.owner, owner.toLowerCase()), eq(repos.repo, repo.toLowerCase()));
}

function repoKey(owner: string, repo: string) {
  return `${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

function prefixKey(prefix: string) {
  return prefix.toLowerCase();
}

export type { RepoStatus };
