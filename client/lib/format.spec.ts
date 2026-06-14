import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { formatSize, formatTime, formatDate, formatUntil, formatRelative } from '@/lib/format';

describe('formatSize', () => {
  it('formats bytes human-readable', () => {
    expect(formatSize(0)).toBe('0 B');
    expect(formatSize(1073741824)).toBe('1.07 GB');
  });
});

describe('formatTime', () => {
  it('formats an ISO string as a locale string', () => {
    expect(formatTime('2026-05-24T12:00:00Z')).toBe(
      new Date('2026-05-24T12:00:00Z').toLocaleString(),
    );
  });
});

describe('formatDate', () => {
  it('formats an ISO string as a locale date (no time)', () => {
    expect(formatDate('2026-05-24T12:00:00Z')).toBe(
      new Date('2026-05-24T12:00:00Z').toLocaleDateString(),
    );
  });
});

describe('formatUntil', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const until = (ms: number) => formatUntil(new Date(Date.now() + ms).toISOString());

  it('reports "now" once the instant has elapsed', () => {
    expect(until(0)).toBe('now');
    expect(formatUntil(new Date(Date.now() - 10_000).toISOString())).toBe('now');
  });

  it('counts minutes under an hour', () => {
    expect(until(60 * 1000)).toBe('1 m');
    expect(until(59 * 60 * 1000)).toBe('59 m');
  });

  it('counts hours under a day', () => {
    expect(until(60 * 60 * 1000)).toBe('1 h');
    expect(until(23 * 60 * 60 * 1000)).toBe('23 h');
  });

  it('counts days beyond that', () => {
    expect(until(24 * 60 * 60 * 1000)).toBe('1 d');
    expect(until(10 * 24 * 60 * 60 * 1000)).toBe('10 d');
  });
});

describe('formatRelative', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const ago = (ms: number) => formatRelative(new Date(Date.now() - ms).toISOString());

  it('counts seconds under a minute', () => {
    expect(ago(0)).toBe('0 s ago');
    expect(ago(5 * 1000)).toBe('5 s ago');
    expect(ago(59 * 1000)).toBe('59 s ago');
  });

  it('counts minutes under an hour', () => {
    expect(ago(60 * 1000)).toBe('1 m ago');
    expect(ago(59 * 60 * 1000)).toBe('59 m ago');
  });

  it('counts hours under a day', () => {
    expect(ago(60 * 60 * 1000)).toBe('1 h ago');
    expect(ago(23 * 60 * 60 * 1000)).toBe('23 h ago');
  });

  it('counts days beyond that', () => {
    expect(ago(24 * 60 * 60 * 1000)).toBe('1 d ago');
    expect(ago(10 * 24 * 60 * 60 * 1000)).toBe('10 d ago');
  });

  it('clamps future timestamps to 0s', () => {
    expect(formatRelative(new Date(Date.now() + 10_000).toISOString())).toBe('0 s ago');
  });
});
