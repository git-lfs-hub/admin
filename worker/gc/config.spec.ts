import { describe, test, expect } from 'vitest';

import { gcConfig } from '@/gc/config';

describe('gcConfig', () => {
  test('fills every default when GC is empty', () => {
    expect(gcConfig({ GC: {} } as any)).toEqual({
      autoDays: { archive: 7, clear: 30 },
      confirmDays: 3,
      retentionDays: { live: 30, cold: 365 },
      coldStorage: '',
    });
  });

  test('defaults the whole GC var when it is absent', () => {
    expect(gcConfig({} as any).confirmDays).toBe(3);
  });

  test('config values override defaults', () => {
    const gc = gcConfig({ GC: { confirmDays: 1, coldStorage: 's3' } } as any);
    expect(gc.confirmDays).toBe(1);
    expect(gc.coldStorage).toBe('s3');
    expect(gc.autoDays.archive).toBe(7);
  });
});
