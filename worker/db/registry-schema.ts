import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core';

// repos — GitHub presence (git identity). Keyed lc(owner/repo); populated by reconciliation
// (listing repos under each App installation) + `repository` webhooks. Presence only — purge is
// a storage op, never a repo one. The git↔storage edge is not stored: `lc(storage.prefix)`
// matches `lc(owner/repo)` 1:1.
export const repos = sqliteTable(
  'repos',
  {
    // lowercased
    owner: text('owner').notNull(),
    repo: text('repo').notNull(),
    // `owner/repo` as listed by GitHub (lowercased here; canonical R2 casing lives on
    // `storage.prefix`). Informational — keys nothing.
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

// storage — lifecycle (storage prefix). Keyed by the canonical `OwnerCase/RepoCase` prefix
// lfs-server writes to R2; the R2 key root and the per-prefix STORAGE DO name. NO owner/repo
// columns — a prefix is not a GitHub identity. Holds the GC lifecycle fields.
export const storage = sqliteTable('storage', {
  prefix: text('prefix').primaryKey(),
  // STORAGE LIFECYCLE (resting states only): 'used' | 'unused' | 'purged'. No 'archived'
  // (that's the orthogonal `archivedAt` flag) and no 'missing' (a prefix is never probed).
  status: text('status', { enum: ['used', 'unused', 'purged'] })
    .notNull()
    .default('used'),
  firstSeen: text('first_seen').notNull(),
  updatedAt: text('updated_at').notNull(),
  // max ts of an UPLOAD object event; drives backupStale. Bumped by the object-event consumer.
  lastChangeAt: text('last_change_at'),
  // when the prefix lost its last active link (became 'unused'); anchors willArchiveAt.
  unusedAt: text('unused_at'),
  // SERVE-BLOCK flag, orthogonal to status. set = blocked ("archived"); null = serving.
  archivedAt: text('archived_at'),
  // when the last BackUp finished, any state; existence marker for a cold copy.
  backedUpAt: text('backed_up_at'),
  // true only if blocked the entire backup → cold copy provably complete; the Clear gate.
  backupComplete: integer('backup_complete', { mode: 'boolean' }).notNull().default(false),
  // when Clear started (cold storage); once set, Restore needs Glacier.
  clearedAt: text('cleared_at'),
  purgedAt: text('purged_at'),
  // denormalized in-flight op set/cleared by the per-prefix STORAGE DO; null = idle.
  activeOp: text('active_op'),
});

export type StorageStatus = 'used' | 'unused' | 'purged';

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
