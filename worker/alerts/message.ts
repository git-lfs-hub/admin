import type { AlertKind } from '@/db/alerts-schema';

export type { AlertKind };

// Alert scopes are namespaced `<namespace>:<id>` so future entities (e.g. `repo:`) coexist
// with storage and system rows. Storage lifecycle raises `storage:`; global health `system:`.
export const STORAGE_SCOPE_PREFIX = 'storage:';

/** Storage-prefix alert scope: `storage:lc(owner/repo)`. */
export function scopeFor(owner: string, repo: string): string {
  return `${STORAGE_SCOPE_PREFIX}${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

/** The display id without its namespace (e.g. `storage:acme/app` → `acme/app`). */
export function scopeLabel(scope: string): string {
  return scope.slice(scope.indexOf(':') + 1);
}

export type AlertCopy = { emoji: string; text: string };

export function alertCopy(kind: AlertKind, scope: string): AlertCopy {
  const id = scopeLabel(scope);
  switch (kind) {
    case 'missing':
      return { emoji: '⚠️', text: `${id} storage unused — no live repository` };
    case 'reappeared':
      return { emoji: '🔄', text: `${id} storage back in use` };
    case 'archived':
      return { emoji: '📦', text: `${id} storage archived — serving blocked` };
    case 'restored':
      return { emoji: '♻️', text: `${id} storage restored — serving resumed` };
    case 'purge':
      return {
        emoji: '🔥',
        text: `${id} storage pending purge — confirm to delete now, or it proceeds at the deadline`,
      };
  }
}

export function adminLink(baseUrl: string, scope: string): string {
  return `${baseUrl}/storage?highlight=${encodeURIComponent(scopeLabel(scope))}`;
}

// One-click default action on a non-confirmation alert: the `verb` is the Slack button
// `action_id`, dispatched to the matching storage op by the webhook. Recovery states
// (reappeared/restored) carry none.
export type NotifyActionDef = { verb: 'archive' | 'restore'; label: string };
export type NotifyAction = NotifyActionDef['verb'];

const notifyActions: Partial<Record<AlertKind, NotifyActionDef>> = {
  missing: { verb: 'archive', label: 'Archive' },
  archived: { verb: 'restore', label: 'Restore' },
};

export function notifyActionFor(kind: string): NotifyActionDef | null {
  return notifyActions[kind as AlertKind] ?? null;
}

const notifyActionVerbs = new Set(Object.values(notifyActions).map((a) => a.verb));
export function isNotifyAction(verb: string): verb is NotifyAction {
  return notifyActionVerbs.has(verb as NotifyAction);
}

// Slack button `value` round-trips the alert identity. Delimit on `#` (scope holds `:` and `/`).
export function encodeAction(scope: string, kind: string): string {
  return `${scope}#${kind}`;
}

export function decodeAction(value: string): { scope: string; kind: string } | null {
  const i = value.lastIndexOf('#');
  if (i < 0) return null;
  return { scope: value.slice(0, i), kind: value.slice(i + 1) };
}
