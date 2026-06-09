import type { AlertKind, AlertSeverity } from '@/db/alerts-schema';

export type { AlertKind, AlertSeverity };

// Alert scopes are namespaced `<namespace>:<id>` so future entities (e.g. `repo:`) coexist
// with storage and system rows. Group D raises `storage:` (prefix lifecycle) + `system:`.
export const STORAGE_SCOPE_PREFIX = 'storage:';

/** Storage-prefix alert scope: `storage:lc(owner/repo)`. */
export function scopeFor(owner: string, repo: string): string {
  return `${STORAGE_SCOPE_PREFIX}${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

/** The display id without its namespace (e.g. `storage:acme/app` → `acme/app`). */
export function scopeLabel(scope: string): string {
  return scope.slice(scope.indexOf(':') + 1);
}

export type AlertCopy = { emoji: string; severity: AlertSeverity; text: string };

export function alertCopy(kind: AlertKind, scope: string): AlertCopy {
  const id = scopeLabel(scope);
  switch (kind) {
    case 'missing':
      return {
        emoji: '⚠️',
        severity: 'warning',
        text: `${id} storage unused — no live repository`,
      };
    case 'reappeared':
      return { emoji: '🔄', severity: 'info', text: `${id} storage back in use` };
    case 'archived':
      return { emoji: '📦', severity: 'info', text: `${id} storage archived — serving blocked` };
    case 'restored':
      return { emoji: '♻️', severity: 'info', text: `${id} storage restored — serving resumed` };
  }
}

export function adminLink(baseUrl: string, scope: string): string {
  return `${baseUrl}/storage?highlight=${encodeURIComponent(scopeLabel(scope))}`;
}
