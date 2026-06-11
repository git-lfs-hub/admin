import { describe, test, expect } from 'vitest';

import { gcConfig } from '@/gc/config';

describe('gcConfig', () => {
  test('fills every default when GC is empty', () => {
    expect(gcConfig({ GC: {} } as any)).toEqual({
      autoArchiveDays: 7,
      autoClearDays: 30,
      purgeConfirmDays: 3,
      liveStorageRetentionDays: 30,
      coldStorageRetentionDays: 365,
      coldStorage: '',
    });
  });

  test('defaults the whole GC var when it is absent', () => {
    expect(gcConfig({} as any).purgeConfirmDays).toBe(3);
  });

  test('config values override defaults', () => {
    const gc = gcConfig({ GC: { purgeConfirmDays: 1, coldStorage: 's3' } } as any);
    expect(gc.purgeConfirmDays).toBe(1);
    expect(gc.coldStorage).toBe('s3');
    expect(gc.autoArchiveDays).toBe(7); // untouched keys still default
  });
});
