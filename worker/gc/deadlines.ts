import type { StorageRow } from '@/db/registry';
import type { GcConfig } from '@/gc/config';
import { isoAddDays } from '@/lib/time';

// GC lifecycle deadline by op. Each policy is `<anchor timestamp> + <window>`, consumed by both the
// cron that enforces it and the UI countdown in the storage list — so the two can never drift. A
// deadline is `null` until its anchor timestamp exists. Look up by op rather than importing each.
export const dueAt = {
  // `unusedAt + autoDays.archive` — auto-block an unused, not-yet-blocked prefix. null once blocked
  // or no longer unused (only those prefixes have an archive deadline).
  archive(row: StorageRow, gc: GcConfig): string | null {
    if (row.status !== 'unused' || row.archivedAt || !row.unusedAt) return null;
    return isoAddDays(row.unusedAt, gc.autoDays.archive);
  },
  // `archivedAt + autoDays.clear` — auto-clear a blocked prefix's live R2 (cold copy kept).
  clear(row: StorageRow, gc: GcConfig): string | null {
    return row.archivedAt ? isoAddDays(row.archivedAt, gc.autoDays.clear) : null;
  },
  // `archivedAt + retentionDays` — auto-purge a blocked prefix (UI's `willPurgeAt`).
  purge(row: StorageRow, gc: GcConfig): string | null {
    return row.archivedAt ? isoAddDays(row.archivedAt, retentionDays(gc)) : null;
  },
} as const;

// Effective retention before auto-Purge: a cold copy outlives live-only R2.
export function retentionDays(gc: GcConfig): number {
  return gc.coldStorage ? gc.retentionDays.cold : gc.retentionDays.live;
}

// `updatedAt + confirmDays` — the confirm deadline shown while a purge awaits approval
// (op-start is the row's `updatedAt`). null when no purge is in flight.
export function purgeConfirmDueAt(row: StorageRow, gc: GcConfig): string | null {
  return row.activeOp === 'purge' ? isoAddDays(row.updatedAt, gc.confirmDays) : null;
}

// A deadline has arrived when it's set and not in the future.
export function isDue(deadline: string | null, now: number): boolean {
  return deadline != null && Date.parse(deadline) <= now;
}
