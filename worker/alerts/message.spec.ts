import { describe, expect, test } from 'vitest';

import { adminLink, alertCopy, scopeFor, scopeLabel } from '@/alerts/message';
import { alertKinds } from '@/db/alerts-schema';

describe('scopeFor / scopeLabel', () => {
  test('scopeFor namespaces with `storage:` and lowercases both segments', () => {
    expect(scopeFor('Alice', 'My-Repo')).toBe('storage:alice/my-repo');
  });

  test('scopeLabel strips the namespace', () => {
    expect(scopeLabel('storage:alice/my-repo')).toBe('alice/my-repo');
    expect(scopeLabel('system:slack')).toBe('slack');
  });
});

describe('alertCopy', () => {
  test('every kind has copy with severity + the bare id embedded (no namespace)', () => {
    for (const kind of alertKinds) {
      const copy = alertCopy(kind, 'storage:alice/repo');
      expect(copy.emoji).toBeTruthy();
      expect(['info', 'warning']).toContain(copy.severity);
      expect(copy.text).toContain('alice/repo');
      expect(copy.text).not.toContain('storage:');
    }
  });

  test('unused storage warns; recovery + serve-block states are info', () => {
    expect(alertCopy('missing', 's').severity).toBe('warning');
    expect(alertCopy('reappeared', 's').severity).toBe('info');
    expect(alertCopy('archived', 's').severity).toBe('info');
    expect(alertCopy('restored', 's').severity).toBe('info');
  });
});

describe('adminLink', () => {
  test('deep-links the storage view with the namespace-stripped id, encoded', () => {
    expect(adminLink('https://admin.example', 'storage:alice/my-repo')).toBe(
      'https://admin.example/storage?highlight=alice%2Fmy-repo',
    );
  });
});
