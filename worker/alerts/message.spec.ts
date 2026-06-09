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
  test('every kind has copy with the bare id embedded (no namespace)', () => {
    for (const kind of alertKinds) {
      const copy = alertCopy(kind, 'storage:alice/repo');
      expect(copy.emoji).toBeTruthy();
      expect(copy.text).toContain('alice/repo');
      expect(copy.text).not.toContain('storage:');
    }
  });
});

describe('adminLink', () => {
  test('deep-links the storage view with the namespace-stripped id, encoded', () => {
    expect(adminLink('https://admin.example', 'storage:alice/my-repo')).toBe(
      'https://admin.example/storage?highlight=alice%2Fmy-repo',
    );
  });
});
