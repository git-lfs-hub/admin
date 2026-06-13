import { sqliteTable, text, primaryKey } from 'drizzle-orm/sqlite-core';

// Alert kind → mode. `notify` raises with no decision; `confirm` carries approve/cancel.
export const alertModes = {
  missing: 'notify',
  reappeared: 'notify',
  archived: 'notify',
  restored: 'notify',
  clear: 'confirm',
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

// Severity per kind; denormalized onto each row for the UI.
export const alertSeverity: Record<AlertKind, AlertSeverity> = {
  missing: 'warning',
  reappeared: 'info',
  archived: 'info',
  restored: 'info',
  clear: 'warning',
  purge: 'warning',
};

// Decision verbs — also the Slack button `action_id`s (no remapping). Latest wins: one decision
// stands per alert.
export const decisions = ['approve', 'cancel'] as const;
export type Decision = (typeof decisions)[number];
export const isDecision = (s: string): s is Decision =>
  (decisions as readonly string[]).includes(s);

// Non-storage scopes live here too (e.g. `system:slack`), so `kind` is plain text, not the enum.
export const SYSTEM_SLACK_SCOPE = 'system:slack';

// Singleton ALERTS DO holds every alert, keyed `(scope, kind)`. `scope` is `storage:lc(owner/repo)`
// for storage alerts or a `system:*` channel for global health. `detail` is free text, null for
// storage alerts.
export const alerts = sqliteTable(
  'alerts',
  {
    scope: text('scope').notNull(),
    kind: text('kind').notNull(),
    severity: text('severity', { enum: alertSeverities }).notNull(),
    detail: text('detail'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    // Confirmation kinds only; null for notify kinds and pending confirmations. The gate keys
    // on `decision` presence.
    decision: text('decision', { enum: decisions }),
    decidedAt: text('decided_at'),
    decidedBy: text('decided_by'),
  },
  (t) => [primaryKey({ columns: [t.scope, t.kind] })],
);

// One Slack message per scope, edited in place (chat.update) as state changes — so a prefix's
// missing → archived → restored shows as one updating message, not four. `kind` is the
// currently-shown state (skip the update when unchanged).
export const slack = sqliteTable('slack', {
  scope: text('scope').primaryKey(),
  kind: text('kind').notNull(),
  sentAt: text('sent_at').notNull(),
  channel: text('channel').notNull(),
  ts: text('ts').notNull(), // chat.postMessage ts — the chat.update handle
});
