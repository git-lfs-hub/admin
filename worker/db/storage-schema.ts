import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';

export const objectStatuses = ['pending', 'present', 'missing', 'deleted', 'purged'] as const;
export type ObjectStatus = (typeof objectStatuses)[number];

export const objectSources = ['upload', 'verify', 'download', 'storage_scan'] as const;
export type ObjectSource = (typeof objectSources)[number];

export const objects = sqliteTable('objects', {
  oid: text('oid').primaryKey(),
  size: integer('size').notNull(),
  status: text('status', { enum: objectStatuses }).notNull().default('pending'),
  source: text('source', { enum: objectSources }).notNull(),
  firstSeen: text('first_seen').notNull(),
  lastSeen: text('last_seen').notNull(),
  lastAccessed: text('last_accessed').notNull(),
});

export const workflowOps = ['backup', 'clear', 'restore', 'purge', 'deleteBackup'] as const;
export type WorkflowOp = (typeof workflowOps)[number];

export const workflowStatuses = [
  'queued',
  'running',
  'paused',
  'waiting',
  'errored',
  'complete',
  'terminated',
] as const;
export type WorkflowStatus = (typeof workflowStatuses)[number];

// One row per Cloudflare Workflow instance for this prefix. The prefix is the DO's identity
// (its name), not a column. ≤1 active op per prefix (all active rows share one `op`, N shards).
export const workflows = sqliteTable(
  'workflows',
  {
    instanceId: text('instance_id').primaryKey(),
    op: text('op', { enum: workflowOps }).notNull(),
    shard: integer('shard'),
    status: text('status', { enum: workflowStatuses }).notNull(),
    startedAt: text('started_at').notNull(),
    endedAt: text('ended_at'),
    cancelRequestedAt: text('cancel_requested_at'),
    error: text('error'),
  },
  (table) => [index('workflows_active').on(table.endedAt)],
);
