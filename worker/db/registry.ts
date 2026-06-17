import { DurableObject } from 'cloudflare:workers';
import { and, eq, inArray, isNotNull, isNull, ne, notInArray, sql, type SQL } from 'drizzle-orm';
import { drizzle, DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';

import {
  repos,
  storage,
  links,
  orgs,
  type RepoStatus,
  type StorageStatus,
  type OrgStatus,
} from '@/db/registry-schema';
import { isoNow } from '@/lib/time';

export type RepoRow = typeof repos.$inferSelect;
export type StorageRow = typeof storage.$inferSelect;
export type LinkRow = typeof links.$inferSelect;
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

/** Singleton registry DO (`getByName("global")`). Tables: `repos` (git presence), `storage`
 *  (prefix lifecycle), `links` (git↔prefix N:N graph, from `.lfsconfig`), `orgs` (reconciliation
 *  state). The git↔storage edge is the real `links` graph, not a same-key inference. */
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
        CREATE TABLE IF NOT EXISTS links (
          owner      TEXT NOT NULL,
          repo       TEXT NOT NULL,
          prefix     TEXT NOT NULL,
          status     TEXT NOT NULL DEFAULT 'active',
          first_seen TEXT NOT NULL,
          last_seen  TEXT NOT NULL,
          PRIMARY KEY (owner, repo, prefix)
        )
      `);
      this.ctx.storage.sql.exec(`CREATE INDEX IF NOT EXISTS links_prefix ON links (prefix)`);
      this.ctx.storage.sql.exec(`CREATE INDEX IF NOT EXISTS links_repo ON links (owner, repo)`);
    });
  }

  // --- live updates: push a tick to every connected admin SPA on each storage write ---

  // Hibernatable WebSocket: the SPA opens `/api/live` (proxied to this DO). Push-only — no
  // message/close handlers needed (the runtime drops closed sockets from `getWebSockets()`), and
  // it survives DO hibernation between writes.
  override async fetch(req: Request): Promise<Response> {
    if (req.headers.get('upgrade') !== 'websocket')
      return new Response('expected websocket', { status: 426 });
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  // Wake every connected client to refetch the named topic. Called only after a row actually
  // changes; the SPA filters by topic (one socket sees both).
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
    // New repo → tell clients; a re-upsert only bumps `updatedAt` (not shown), so stay quiet.
    if (!existed) this.broadcast('repos');
    return row;
  }

  /** Reconcile `repos` against an org listing: upsert every active repo (flipping
   *  `missing`→`active`), and mark `missing` any tracked repo in an active org absent from
   *  the listing. */
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

  /** Per-repo analogue of `recordReconciliation` for a webhook event. Untracked repos are
   *  created on a present event, ignored on an absent one. */
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
    // New prefix → tell clients; a re-upsert only bumps `updatedAt` (not shown), so stay quiet
    // to avoid churn each reconcile tick.
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

  /** Stamp `clearedAt` at a ClearWorkflow's start. Only a blocked, not-yet-cleared prefix. */
  async markCleared(prefix: string): Promise<StorageRow | null> {
    const now = isoNow();
    return this.updateStorage(
      prefix,
      { clearedAt: now, updatedAt: now },
      and(isNotNull(storage.archivedAt), isNull(storage.clearedAt)),
    );
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

  /** Reconcile every non-purged prefix's link state: `used` while ≥1 active `links` row ties it to
   *  an `active` git repo, `unused` otherwise. Returns the flips, plus `blockedReused` (became used
   *  but still blocked) for the caller to unblock/alert. */
  async reconcileStorage(): Promise<StorageReconciliationResult> {
    const out: StorageReconciliationResult = {
      becameUnused: [],
      becameUsed: [],
      blockedReused: [],
    };
    const inUse = await this.inUsePrefixes();
    const rows = await this.db.select().from(storage).where(ne(storage.status, 'purged'));
    for (const row of rows) {
      await this.applyLinkState(row, inUse.has(row.prefix), out);
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
    await this.applyLinkState(row, await this.storageInUse(prefix), out);
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

  /** Distinct prefixes with ≥1 active `links` row tying them to an `active` git repo. */
  private async inUsePrefixes(): Promise<Set<string>> {
    const rows = await this.db
      .selectDistinct({ prefix: links.prefix })
      .from(links)
      .innerJoin(repos, and(eq(links.owner, repos.owner), eq(links.repo, repos.repo)))
      .where(and(eq(links.status, 'active'), eq(repos.status, 'active')));
    return new Set(rows.map((r) => r.prefix));
  }

  /** Resolve a storage row from its prefix path, case-insensitively (route params / alert scopes
   *  carry the lowercased prefix). Not a git→storage traversal — that goes through `links`. */
  async getStorageByPrefix(prefix: string): Promise<StorageRow | null> {
    const [row] = await this.db
      .select()
      .from(storage)
      .where(eq(sql`lower(${storage.prefix})`, prefix.toLowerCase()));
    return row ?? null;
  }

  /** Purge gate: a prefix is in use while an active link ties it to an `active` git repo. */
  async storageInUse(prefix: string): Promise<boolean> {
    return (await this.listActiveLinks(prefix)).length > 0;
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

  /** Land a finished BackUp (cross-DO from the STORAGE DO): a cold copy now exists (`backedUpAt`),
   *  complete only if the prefix stayed blocked under the same `archivedAt` throughout. */
  async endBackup(prefix: string, archivedAtAtStart: string | null): Promise<void> {
    const now = isoNow();
    const row = await this.getStorage(prefix);
    const complete = archivedAtAtStart != null && row?.archivedAt === archivedAtAtStart;
    await this.updateStorage(prefix, {
      backedUpAt: now,
      backupComplete: complete,
      activeOp: null,
      updatedAt: now,
    });
  }

  /** Land a finished cold Restore (cross-DO from the STORAGE DO): live R2 holds every object again,
   *  so clear the block (`archivedAt`/`clearedAt`) and `backupComplete`. `backedUpAt` stays — the
   *  cold copy still exists. */
  async endRestore(prefix: string): Promise<void> {
    await this.updateStorage(prefix, {
      archivedAt: null,
      clearedAt: null,
      backupComplete: false,
      activeOp: null,
      updatedAt: isoNow(),
    });
  }

  /** Land a finished Clear: cold copy + block remain, so only drop `activeOp` (`clearedAt` was
   *  stamped at the workflow's start). */
  async endClear(prefix: string): Promise<void> {
    await this.updateStorage(prefix, { activeOp: null, updatedAt: isoNow() });
  }

  /** Land a finished Delete Backup (cross-DO from the STORAGE DO): the cold copy is gone, so clear
   *  `backedUpAt`/`backupComplete`. Live R2 + status untouched. */
  async endDeleteBackup(prefix: string): Promise<void> {
    await this.updateStorage(prefix, {
      backedUpAt: null,
      backupComplete: false,
      activeOp: null,
      updatedAt: isoNow(),
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

  // --- links: git↔prefix graph (N:N), written by REPO.syncLinks() ---

  /** Project a repo's current local-prefix set onto `links`: upsert each prefix `active`
   *  (bump `lastSeen`), and mark `stale` any active link for this repo whose prefix dropped out
   *  of the set. `prefixes` is the canonical `OwnerCase/RepoCase` prefixes the repo still
   *  references. */
  async syncLinks(owner: string, repo: string, prefixes: Set<string>): Promise<void> {
    const o = owner.toLowerCase();
    const r = repo.toLowerCase();
    const now = isoNow();
    for (const prefix of prefixes) {
      await this.db
        .insert(links)
        .values({ owner: o, repo: r, prefix, firstSeen: now, lastSeen: now })
        .onConflictDoUpdate({
          target: [links.owner, links.repo, links.prefix],
          set: { status: 'active', lastSeen: now },
        });
    }
    const kept = [...prefixes];
    await this.db
      .update(links)
      .set({ status: 'stale', lastSeen: now })
      .where(
        and(
          eq(links.owner, o),
          eq(links.repo, r),
          eq(links.status, 'active'),
          ...(kept.length ? [notInArray(links.prefix, kept)] : []),
        ),
      );
  }

  /** A git repo went `missing` → mark all its active links `stale`. */
  async staleLinksForRepo(owner: string, repo: string): Promise<void> {
    await this.db
      .update(links)
      .set({ status: 'stale', lastSeen: isoNow() })
      .where(
        and(
          eq(links.owner, owner.toLowerCase()),
          eq(links.repo, repo.toLowerCase()),
          eq(links.status, 'active'),
        ),
      );
  }

  /** Purge gate: active links to a prefix from an `active` git repo. Non-empty → prefix in use. */
  async listActiveLinks(prefix: string): Promise<LinkRow[]> {
    return await this.db
      .select({
        owner: links.owner,
        repo: links.repo,
        prefix: links.prefix,
        status: links.status,
        firstSeen: links.firstSeen,
        lastSeen: links.lastSeen,
      })
      .from(links)
      .innerJoin(repos, and(eq(links.owner, repos.owner), eq(links.repo, repos.repo)))
      .where(and(eq(links.prefix, prefix), eq(links.status, 'active'), eq(repos.status, 'active')));
  }

  /** All links (any status) for a git repo — its consumed prefixes. */
  async listLinksForRepo(owner: string, repo: string): Promise<LinkRow[]> {
    return await this.db
      .select()
      .from(links)
      .where(and(eq(links.owner, owner.toLowerCase()), eq(links.repo, repo.toLowerCase())));
  }

  /** All links (any status) for a prefix — its consumer git repos. */
  async listLinksForStorage(prefix: string): Promise<LinkRow[]> {
    return await this.db.select().from(links).where(eq(links.prefix, prefix));
  }

  /** Active links joined to their storage row — each git repo's consumed prefixes, for `/api/repos`. */
  async listActiveRepoLinks(): Promise<
    {
      owner: string;
      repo: string;
      prefix: string;
      status: StorageStatus;
      archivedAt: string | null;
    }[]
  > {
    return await this.db
      .select({
        owner: links.owner,
        repo: links.repo,
        prefix: links.prefix,
        status: storage.status,
        archivedAt: storage.archivedAt,
      })
      .from(links)
      .innerJoin(storage, eq(storage.prefix, links.prefix))
      .where(eq(links.status, 'active'));
  }

  /** Active links joined to their consumer git repo — each prefix's consumers, for `/api/storage`. */
  async listActiveStorageLinks(): Promise<
    { prefix: string; owner: string; repo: string; status: RepoStatus }[]
  > {
    return await this.db
      .select({
        prefix: links.prefix,
        owner: repos.owner,
        repo: repos.repo,
        status: repos.status,
      })
      .from(links)
      .innerJoin(repos, and(eq(links.owner, repos.owner), eq(links.repo, repos.repo)))
      .where(eq(links.status, 'active'));
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
}

function repoKeyWhere(owner: string, repo: string) {
  return and(eq(repos.owner, owner.toLowerCase()), eq(repos.repo, repo.toLowerCase()));
}

function repoKey(owner: string, repo: string) {
  return `${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

export type { RepoStatus };
