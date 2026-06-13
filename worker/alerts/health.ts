// Shared copy for global-health alerts (`system:*` scopes), so the admin UI and Slack never drift.
export type SystemHealthCopy = { title: string; note?: string };

export type SystemAlert = { scope: string; kind: string };

// A `system:*` scope is global health, rendered apart from resource alerts (`storage:…`).
export const isSystem = (scope: string) => scope.startsWith('system:');

export const SYSTEM_HEALTH: Record<string, SystemHealthCopy> = {
  slack: { title: 'Slack delivery failing', note: 'notifications are in-app only until fixed' },
};

// Falls back to the scope's id (`system:db` → `db`) for unknown kinds.
export function systemCopy(a: SystemAlert): SystemHealthCopy {
  return SYSTEM_HEALTH[a.kind] ?? { title: a.scope.slice(a.scope.indexOf(':') + 1) };
}
