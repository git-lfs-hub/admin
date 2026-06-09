import { sqliteTable, text, primaryKey } from 'drizzle-orm/sqlite-core';

// Storage-lifecycle alert kinds (Group D, notify-only). Confirmation kinds (`clear`/`purge`)
// + their decision columns land in Group E.
export const alertKinds = ['missing', 'reappeared', 'archived', 'restored'] as const;
export type AlertKind = (typeof alertKinds)[number];

export const alertSeverities = ['info', 'warning'] as const;
export type AlertSeverity = (typeof alertSeverities)[number];

// Non-storage scopes live here too (e.g. `system:slack` for delivery health), so `kind` is
// plain text, not the storage enum.
export const SYSTEM_SLACK_SCOPE = 'system:slack';

// One singleton ALERTS DO holds every alert, keyed `(scope, kind)`. `scope` is `lc(owner/repo)`
// for storage alerts or a `system:*` channel for global health. `detail` is free text (e.g. a
// Slack error message); null for storage alerts.
export const alerts = sqliteTable(
  'alerts',
  {
    scope: text('scope').notNull(),
    kind: text('kind').notNull(),
    severity: text('severity', { enum: alertSeverities }).notNull(),
    detail: text('detail'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.scope, t.kind] })],
);

// One Slack message per scope, edited in place (chat.update) as its state changes — so a
// prefix's missing → archived → restored shows as one updating message, not four. `kind` is
// the currently-shown state (skip the update when it hasn't changed).
export const slack = sqliteTable('slack', {
  scope: text('scope').primaryKey(),
  kind: text('kind').notNull(),
  sentAt: text('sent_at').notNull(),
  channel: text('channel').notNull(),
  ts: text('ts').notNull(), // chat.postMessage ts — the chat.update handle
});
