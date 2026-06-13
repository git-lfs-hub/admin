import type { AlertKind } from '@/db/alerts-schema';
import {
  STORAGE_ACTIONS,
  STORAGE_STATES,
  type LifecycleState,
  type StorageAction,
} from '@/storage/actions';

export type { AlertKind };

// Alert scopes are namespaced `<namespace>:<id>` so future entities coexist with storage/system.
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

// Each alert kind reduces to a lifecycle state, so UI copy and the Slack line never drift.
const stateOfKind: Record<AlertKind, LifecycleState> = {
  missing: 'unused',
  reappeared: 'used',
  archived: 'archived',
  restored: 'used',
  purge: 'purging',
};

export function alertCopy(kind: AlertKind, scope: string): AlertCopy {
  const { emoji, line } = STORAGE_STATES[stateOfKind[kind]];
  return { emoji, text: `\`${scopeLabel(scope)}\` ${line}` };
}

export function adminLink(baseUrl: string, scope: string): string {
  return `${baseUrl}/storage?highlight=${encodeURIComponent(scopeLabel(scope))}`;
}

// One-click default action on a notify alert; the `verb` is the Slack button `action_id`. The
// lifecycle state picks it (unused → Archive, archived → Restore); other states carry none.
export type NotifyAction = Extract<StorageAction, 'archive' | 'restore'>;

export function notifyActionFor(
  kind: string,
): ({ verb: NotifyAction } & (typeof STORAGE_ACTIONS)[NotifyAction]) | null {
  const state = stateOfKind[kind as AlertKind];
  const verb = state && STORAGE_STATES[state].action;
  if (verb !== 'archive' && verb !== 'restore') return null;
  return { verb, ...STORAGE_ACTIONS[verb] };
}

const notifyActionVerbs = new Set(
  Object.values(STORAGE_STATES)
    .map((s) => s.action)
    .filter((a): a is NotifyAction => a !== undefined),
);
export function isNotifyAction(verb: string): verb is NotifyAction {
  return notifyActionVerbs.has(verb as NotifyAction);
}

// Slack button `value` round-trips the alert identity. Delimit on `#` (scope holds `:` and `/`).
// oxlint-disable-next-line no-unused-vars
export function encodeAction(scope: string, kind: string): string {
  return `${scope}#${kind}`;
}

export function decodeAction(value: string): { scope: string; kind: string } | null {
  const i = value.lastIndexOf('#');
  if (i < 0) return null;
  return { scope: value.slice(0, i), kind: value.slice(i + 1) };
}
