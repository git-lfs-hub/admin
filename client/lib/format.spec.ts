import { describe, expect, it } from 'vitest';

import { formatSize, formatTime, formatRelative } from '@/lib/format';

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

describe('formatRelative', () => {
  const ago = (ms: number) => formatRelative(new Date(Date.now() - ms).toISOString());

  it('counts seconds under a minute', () => {
    expect(ago(0)).toBe('0s ago');
    expect(ago(5 * 1000)).toBe('5s ago');
    expect(ago(59 * 1000)).toBe('59s ago');
  });

  it('counts minutes under an hour', () => {
    expect(ago(60 * 1000)).toBe('1m ago');
    expect(ago(59 * 60 * 1000)).toBe('59m ago');
  });

  it('counts hours under a day', () => {
    expect(ago(60 * 60 * 1000)).toBe('1h ago');
    expect(ago(23 * 60 * 60 * 1000)).toBe('23h ago');
  });

  it('counts days beyond that', () => {
    expect(ago(24 * 60 * 60 * 1000)).toBe('1d ago');
    expect(ago(10 * 24 * 60 * 60 * 1000)).toBe('10d ago');
  });

  it('clamps future timestamps to 0s', () => {
    expect(formatRelative(new Date(Date.now() + 10_000).toISOString())).toBe('0s ago');
  });
});
