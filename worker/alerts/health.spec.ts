import { describe, expect, test } from 'vitest';

import { SYSTEM_HEALTH, isSystem, systemCopy } from '@/alerts/health';

describe('isSystem', () => {
  test('true for system: scopes, false for resource scopes', () => {
    expect(isSystem('system:slack')).toBe(true);
    expect(isSystem('storage:acme/app')).toBe(false);
  });
});

describe('systemCopy', () => {
  test('known kind → catalog title + note', () => {
    expect(systemCopy({ scope: 'system:slack', kind: 'slack' })).toEqual(SYSTEM_HEALTH.slack);
  });

  test('unknown kind → bare scope id, no note', () => {
    expect(systemCopy({ scope: 'system:db', kind: 'lag' })).toEqual({ title: 'db' });
  });
});
