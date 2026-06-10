import { sqliteTable, text, primaryKey } from 'drizzle-orm/sqlite-core';

// Alert kinds → mode (single source of truth). `notify` raises with no decision; `confirm`
// (`purge` now; `clear` later) carries approve/cancel.
export const alertModes = {
  missing: 'notify',
  reappeared: 'notify',
  archived: 'notify',
  restored: 'notify',
  purge: 'confirm',
} as const;

export type AlertKind = keyof typeof alertModes;
export type ConfirmKind = {
  [K in AlertKind]: (typeof alertModes)[K] extends 'confirm' ? K : never;
}[AlertKind];
export type NotifyKind = Exclude<AlertKind, ConfirmKind>;

export const alertKinds = Object.keys(alertModes) as AlertKind[];

export function isConfirmKind(kind: string): kind is ConfirmKind {
  return alertModes[kind as AlertKind] === 'confirm';
}

export const alertSeverities = ['info', 'warning'] as const;
export type AlertSeverity = (typeof alertSeverities)[number];

// Severity is a property of the kind (denormalized onto each row for the UI). Source of truth.
export const alertSeverity: Record<AlertKind, AlertSeverity> = {
  missing: 'warning',
  reappeared: 'info',
  archived: 'info',
  restored: 'info',
  purge: 'warning',
};

// Confirmation decision verbs — also the Slack button `action_id`s (no remapping). Latest wins:
// a `cancel` after `approve` (or vice versa) overwrites; only one decision stands per alert.
export const decisions = ['approve', 'cancel'] as const;
export type Decision = (typeof decisions)[number];
export const isDecision = (s: string): s is Decision =>
  (decisions as readonly string[]).includes(s);

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
    // Confirmation kinds only (`purge`); null for notify kinds and pending confirmations.
    // The gate keys on `decision` presence, not "deadlines".
    decision: text('decision', { enum: decisions }),
    decidedAt: text('decided_at'),
    decidedBy: text('decided_by'),
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
