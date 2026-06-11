// Shared vocabulary for global-health alerts (`system:*` scopes) — the single source of truth for
// how each kind reads, so the admin UI (AppHeader) and any future surface never drift. Mirrors
// storage/actions.ts for the storage lifecycle.
export type SystemHealthCopy = { title: string; note?: string };

// Minimal alert shape both worker rows and client API rows satisfy.
export type SystemAlert = { scope: string; kind: string };

// A `system:*` scope is global health, rendered apart from resource alerts (`storage:…`).
export const isSystem = (scope: string) => scope.startsWith('system:');

// Per `kind`. Unknown kinds fall back to the bare scope id (see `systemCopy`).
export const SYSTEM_HEALTH: Record<string, SystemHealthCopy> = {
  slack: { title: 'Slack delivery failing', note: 'notifications are in-app only until fixed' },
};

// Title + optional note for a `system:*` alert; falls back to the scope's id (`system:db` → `db`).
export function systemCopy(a: SystemAlert): SystemHealthCopy {
  return SYSTEM_HEALTH[a.kind] ?? { title: a.scope.slice(a.scope.indexOf(':') + 1) };
}
