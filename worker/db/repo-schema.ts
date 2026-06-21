import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';

// branches — one row per branch of the git repo (UPSERTed on head change, not append-only).
// `.lfsconfig` observation columns plus the lifecycle columns (status/tree_sha/dirty/...) that
// drive branch-delete detection.
export const branchStatuses = ['active', 'missing', 'deleted'] as const;
export type BranchStatus = (typeof branchStatuses)[number];

export const branches = sqliteTable('branches', {
  branch: text('branch').primaryKey(),
  headSha: text('head_sha').notNull(),
  seenAt: text('seen_at').notNull(),
  // → lfsconfigs.sha; null when lfsconfigStatus = 'missing'.
  lfsconfigSha: text('lfsconfig_sha'),
  lfsconfigStatus: text('lfsconfig_status', { enum: ['ok', 'missing', 'parse_error'] }),
  // lifecycle
  status: text('status', { enum: branchStatuses }).notNull().default('active'),
  treeSha: text('tree_sha'), // root tree ref_paths reflects (dedup key for resolve)
  dirty: integer('dirty', { mode: 'boolean' }).notNull().default(false), // ref_paths stale → re-resolve
  gitattrSha: text('gitattr_sha'), // → gitattributes.sha at the tip
  scannedAt: text('scanned_at'), // when ref_paths was last made consistent; null = never resolved
  missingAt: text('missing_at'),
  deletedAt: text('deleted_at'), // soft-delete anchor; willPurgeAt derived at read time
});

export type LfsconfigStatus = 'ok' | 'missing' | 'parse_error';

// ref_paths — tip-of-ref live state: which OID each ref references at which path. Shared by branches
// (refs/heads/*) and tags (refs/tags/*); `ref` is the full git ref. Records ALL git-referenced
// OIDs, even those not yet in STORAGE.objects (avoids a scan-before-upload race).
export const refPaths = sqliteTable(
  'ref_paths',
  {
    oid: text('oid').notNull(),
    ref: text('ref').notNull(),
    path: text('path').notNull(),
  },
  (t) => [index('idx_ref_paths_oid').on(t.oid)],
);

// lfs_pointers — content-addressed pointer-parse cache, deduped across branches/repos. `oid = null`
// is a negative entry: matched .gitattributes but isn't an LFS pointer (no refetch).
export const lfsPointers = sqliteTable('lfs_pointers', {
  sha: text('sha').primaryKey(), // git blob sha
  oid: text('oid'), // LFS object id (sha256), or null
  size: integer('size'), // LFS object size, or null
});

// gitattributes — .gitattributes content cache, keyed by blob sha.
export const gitattributes = sqliteTable('gitattributes', {
  sha: text('sha').primaryKey(),
  content: text('content').notNull(),
});

// lfsconfigs — parse result keyed by git blob sha of the `.lfsconfig` bytes, deduped across
// branches/repos. `local = 1` iff `host` matches this deployment (lfsEndpoint).
export const lfsconfigs = sqliteTable('lfsconfigs', {
  sha: text('sha').primaryKey(),
  host: text('host').notNull(),
  prefix: text('prefix').notNull(),
  local: integer('local', { mode: 'boolean' }).notNull(),
  status: text('status', { enum: ['ok', 'parse_error'] }).notNull(),
  parsedAt: text('parsed_at').notNull(),
});

export type LfsconfigParseStatus = 'ok' | 'parse_error';
