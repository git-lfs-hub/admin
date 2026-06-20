import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

// branches — one row per branch of the git repo (UPSERTed on head change, not append-only).
// Phase 1.5 fills only the `.lfsconfig` observation columns for the default branch; Phase 2
// ALTERs in the lifecycle columns (status, scanned_at, missing_at, deleted_at) + branch_paths.
export const branches = sqliteTable('branches', {
  branch: text('branch').primaryKey(),
  headSha: text('head_sha').notNull(),
  seenAt: text('seen_at').notNull(),
  // → lfsconfigs.sha; null when lfsconfigStatus = 'missing'.
  lfsconfigSha: text('lfsconfig_sha'),
  lfsconfigStatus: text('lfsconfig_status', { enum: ['ok', 'missing', 'parse_error'] }),
});

export type LfsconfigStatus = 'ok' | 'missing' | 'parse_error';

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
