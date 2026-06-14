import { describe, test, expect } from 'vitest';

import { retentionDays, dueAt, purgeConfirmDueAt, isDue } from '@/gc/deadlines';
import { isoAddDays } from '@/lib/time';

const gc = (over: Record<string, unknown> = {}) =>
  ({
    autoDays: { archive: 7, clear: 30 },
    confirmDays: 3,
    retentionDays: { live: 30, cold: 1095 },
    coldStorage: '',
    ...over,
  }) as any;

const row = (over: Record<string, unknown> = {}) =>
  ({
    prefix: 'a/r',
    status: 'unused',
    activeOp: null,
    unusedAt: null,
    archivedAt: null,
    updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  }) as any;

describe('retentionDays', () => {
  test('cold storage configured → cold retention', () => {
    expect(retentionDays(gc({ coldStorage: 's3' }))).toBe(1095);
  });

  test('no cold storage → live retention', () => {
    expect(retentionDays(gc())).toBe(30);
  });
});

describe('dueAt.archive', () => {
  test('unused, not blocked → unusedAt + autoDays.archive', () => {
    expect(dueAt.archive(row({ unusedAt: '2026-01-01T00:00:00Z' }), gc())).toBe(
      isoAddDays('2026-01-01T00:00:00Z', 7),
    );
  });

  test('already blocked → null', () => {
    expect(
      dueAt.archive(row({ unusedAt: '2026-01-01T00:00:00Z', archivedAt: 'x' }), gc()),
    ).toBeNull();
  });

  test('not unused → null', () => {
    expect(
      dueAt.archive(row({ status: 'used', unusedAt: '2026-01-01T00:00:00Z' }), gc()),
    ).toBeNull();
  });

  test('no unusedAt anchor → null', () => {
    expect(dueAt.archive(row(), gc())).toBeNull();
  });
});

describe('dueAt.clear', () => {
  test('blocked → archivedAt + autoDays.clear', () => {
    expect(dueAt.clear(row({ archivedAt: '2026-01-01T00:00:00Z' }), gc())).toBe(
      isoAddDays('2026-01-01T00:00:00Z', 30),
    );
  });

  test('not blocked → null', () => {
    expect(dueAt.clear(row(), gc())).toBeNull();
  });
});

describe('dueAt.purge', () => {
  test('blocked, cold → archivedAt + retentionDays.cold', () => {
    expect(
      dueAt.purge(row({ archivedAt: '2026-01-01T00:00:00Z' }), gc({ coldStorage: 's3' })),
    ).toBe(isoAddDays('2026-01-01T00:00:00Z', 1095));
  });

  test('not blocked → null', () => {
    expect(dueAt.purge(row(), gc())).toBeNull();
  });
});

describe('purgeConfirmDueAt', () => {
  test('purge in flight → updatedAt + confirmDays', () => {
    expect(purgeConfirmDueAt(row({ activeOp: 'purge' }), gc())).toBe(
      isoAddDays('2026-01-01T00:00:00Z', 3),
    );
  });

  test('no purge in flight → null', () => {
    expect(purgeConfirmDueAt(row({ activeOp: 'clear' }), gc())).toBeNull();
  });
});

describe('isDue', () => {
  const now = Date.parse('2026-06-13T00:00:00Z');

  test('past deadline → due', () => {
    expect(isDue('2026-06-12T00:00:00Z', now)).toBe(true);
  });

  test('future deadline → not due', () => {
    expect(isDue('2026-06-14T00:00:00Z', now)).toBe(false);
  });

  test('null deadline → not due', () => {
    expect(isDue(null, now)).toBe(false);
  });
});
