import { describe, test, expect } from 'vitest';

import { canPurge, lifecycleState } from '@/storage/actions';

describe('lifecycleState', () => {
  test('purged status wins over the block flag', () => {
    expect(lifecycleState({ status: 'purged', archivedAt: '2026-01-01T00:00:00Z' })).toBe('purged');
  });

  test('archivedAt on a non-purged row → archived (status-independent)', () => {
    expect(lifecycleState({ status: 'used', archivedAt: '2026-01-01T00:00:00Z' })).toBe('archived');
    expect(lifecycleState({ status: 'unused', archivedAt: '2026-01-01T00:00:00Z' })).toBe(
      'archived',
    );
  });

  test('unblocked rows reduce to their link state', () => {
    expect(lifecycleState({ status: 'unused', archivedAt: null })).toBe('unused');
    expect(lifecycleState({ status: 'used', archivedAt: null })).toBe('used');
  });
});

describe('canPurge', () => {
  // Purge is offered for any non-live copy: archived, or unused (archived inline before the run).
  test('archived and unused are purgeable', () => {
    expect(canPurge('archived')).toBe(true);
    expect(canPurge('unused')).toBe(true);
  });

  test('a live or already-terminal copy is not', () => {
    expect(canPurge('used')).toBe(false);
    expect(canPurge('purged')).toBe(false);
  });
});
