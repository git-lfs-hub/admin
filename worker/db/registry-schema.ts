import { sqliteTable, text, integer, primaryKey, index } from 'drizzle-orm/sqlite-core';

// repos — GitHub presence (git identity). Keyed lc(owner/repo); populated by reconciliation +
// `repository` webhooks. The git↔storage edge is not stored: `lc(storage.prefix)` matches
// `lc(owner/repo)` 1:1.
export const repos = sqliteTable(
  'repos',
  {
    // lowercased
    owner: text('owner').notNull(),
    repo: text('repo').notNull(),
    // `owner/repo` as listed by GitHub. Informational — keys nothing.
    name: text('name').notNull(),
    status: text('status', { enum: ['active', 'missing'] })
      .notNull()
      .default('active'),
    firstSeen: text('first_seen').notNull(),
    updatedAt: text('updated_at').notNull(),
    missingAt: text('missing_at'),
  },
  (table) => [primaryKey({ columns: [table.owner, table.repo] })],
);

export type RepoStatus = 'active' | 'missing';

// storage — prefix lifecycle. Keyed by the canonical `OwnerCase/RepoCase` prefix lfs-server writes
// to R2; also the R2 key root and the per-prefix STORAGE DO name. No owner/repo columns — a prefix
// is not a GitHub identity.
export const storage = sqliteTable('storage', {
  prefix: text('prefix').primaryKey(),
  // Resting states only. No 'archived' (the orthogonal `archivedAt` flag) and no 'missing'
  // (a prefix is never probed).
  status: text('status', { enum: ['used', 'unused', 'purged'] })
    .notNull()
    .default('used'),
  firstSeen: text('first_seen').notNull(),
  updatedAt: text('updated_at').notNull(),
  // max ts of an upload event; drives backupStale. Bumped by the object-event consumer.
  lastChangeAt: text('last_change_at'),
  // when the prefix lost its last active link; anchors willArchiveAt.
  unusedAt: text('unused_at'),
  // Serve-block flag, orthogonal to status. set = blocked; null = serving.
  archivedAt: text('archived_at'),
  // when the last BackUp finished, any state; existence marker for a cold copy.
  backedUpAt: text('backed_up_at'),
  // true only if blocked the entire backup → cold copy provably complete; the Clear gate.
  backupComplete: integer('backup_complete', { mode: 'boolean' }).notNull().default(false),
  // when Clear started; once set, Restore needs Glacier.
  clearedAt: text('cleared_at'),
  purgedAt: text('purged_at'),
  // denormalized in-flight op, set/cleared by the per-prefix STORAGE DO; null = idle.
  activeOp: text('active_op'),
});

export type StorageStatus = 'used' | 'unused' | 'purged';

// links — the real git↔prefix graph (N:N), replacing the same-key lookup. One row per
// `lc(owner/repo)` + `prefix`. Written only by `REPO.syncLinks()`: a prefix referenced by a
// `local` `.lfsconfig` on some branch is `active`; one no branch references goes `stale`.
export const links = sqliteTable(
  'links',
  {
    owner: text('owner').notNull(),
    repo: text('repo').notNull(),
    prefix: text('prefix').notNull(),
    status: text('status', { enum: ['active', 'stale'] })
      .notNull()
      .default('active'),
    firstSeen: text('first_seen').notNull(),
    lastSeen: text('last_seen').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.owner, table.repo, table.prefix] }),
    index('links_prefix').on(table.prefix),
    index('links_repo').on(table.owner, table.repo),
  ],
);

export type LinkStatus = 'active' | 'stale';

export const orgs = sqliteTable('orgs', {
  org: text('org').primaryKey(),
  status: text('status', {
    enum: ['active', 'missing', 'no_installation', 'forbidden', 'transient_error'],
  }).notNull(),
  firstSeen: text('first_seen').notNull(),
  updatedAt: text('updated_at').notNull(),
  missingAt: text('missing_at'),
  lastError: text('last_error'),
});

export type OrgStatus = 'active' | 'missing' | 'no_installation' | 'forbidden' | 'transient_error';
