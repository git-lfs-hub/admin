// Shared vocabulary for the storage lifecycle — single source of truth for the admin UI
// (StorageTable) and Slack alerts, so the two never drift. STORAGE_ACTIONS = per-verb button label
// + consequence copy; STORAGE_STATES = per-state emoji, Slack line, UI description, default action.

// Authority on a row's resting lifecycle state; both surfaces derive from this rather than
// re-checking `status`/`archivedAt` inline. `purging` is an in-flight overlay (active op), not a
// resting state, so it's never returned. Minimal row shape so worker + client rows both fit.
export type LifecycleRow = { status: 'used' | 'unused' | 'purged'; archivedAt: string | null };

export function lifecycleState(row: LifecycleRow): LifecycleState {
  if (row.status === 'purged') return 'purged';
  if (row.archivedAt) return 'archived';
  return row.status === 'unused' ? 'unused' : 'used';
}

// The lifecycle states a storage prefix moves through. Slack events (AlertKind) and the UI's row
// status both reduce to one of these. `action` is the default one-click verb a non-terminal state
// offers (unused → Archive, archived → Restore); recovery/terminal states carry none.
export type LifecycleState = 'used' | 'unused' | 'archived' | 'clearing' | 'purging' | 'purged';

type StateMeta = { emoji: string; line: string; description?: string; action?: StorageAction };

export const STORAGE_STATES: Record<LifecycleState, StateMeta> = {
  used: {
    emoji: '🔄',
    line: 'storage back in use',
  },
  unused: {
    emoji: '⚠️',
    line: 'storage unused — no live repository',
    description:
      'No longer serving Git LFS — the repo is missing.\nFiles are kept and the storage will be archived automatically.',
    action: 'archive',
  },
  archived: {
    emoji: '📦',
    line: 'storage archived — serving blocked',
    description: 'This storage no longer serves Git LFS.\nFiles are kept; nothing is deleted.',
    action: 'restore',
  },
  clearing: {
    emoji: '🧹',
    line: 'storage pending clear — confirm to delete the live copy (cold backup kept)',
  },
  purging: {
    emoji: '🔥',
    line: 'storage pending purge — confirm to delete now, or it proceeds at the deadline',
  },
  purged: {
    emoji: '🪦',
    line: 'storage purged — every file deleted',
    description: 'Every file in this storage was permanently deleted.',
  },
};

// `consequence`/`description` are plain text with `\n` line breaks: Slack mrkdwn renders them
// directly; the UI renders them under `whitespace-pre-line`. The cold-storage verbs (backup /
// clear / deleteBackup) only surface in the UI when `env.GC.coldStorage` is set.
export type StorageAction = 'archive' | 'restore' | 'purge' | 'backup' | 'clear' | 'deleteBackup';

export const STORAGE_ACTIONS = {
  backup: {
    label: 'Back up',
    consequence: 'Copies every live file to cold storage. Nothing is deleted.',
  },
  archive: {
    label: 'Archive',
    consequence:
      'Stops this storage from serving Git LFS immediately.\nFiles are kept; serving resumes automatically if the repo reappears on GitHub.',
  },
  restore: {
    label: 'Restore',
    consequence: 'Unarchives this storage so it serves Git LFS again.',
  },
  clear: {
    label: 'Clear',
    consequence:
      'Deletes the live copy of every file; the cold backup is kept.\nRestore brings them back from cold storage.',
  },
  deleteBackup: {
    label: 'Delete backup',
    consequence: 'Deletes the cold backup copy. The live files stay.\nYou can back up again later.',
  },
  purge: {
    label: 'Purge',
    consequence:
      "Permanently deletes every file in this storage. Any repo using it loses those files —\nincluding repos that still exist on GitHub. This can't be undone.",
  },
} as const satisfies Record<StorageAction, { label: string; consequence: string }>;

// Purge is irreversible and only valid once archived — both surfaces gate it the same way: the
// button is offered but disabled until the prefix is archived, with `hint` explaining why.
export const purgeRequires = {
  state: 'archived' as LifecycleState,
  hint: 'Archive this storage first.',
};

export const canPurge = (state: LifecycleState): boolean => state === purgeRequires.state;
