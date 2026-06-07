import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { test, expect } from 'vitest';

import { objects } from '@/db/repo-schema';

test('objects table has primary key on oid', () => {
  const config = getTableConfig(objects);
  const oid = config.columns.find((c) => c.name === 'oid')!;
  expect(oid.primary).toBe(true);
});

test('objects source enum matches schema', () => {
  const config = getTableConfig(objects);
  const source = config.columns.find((c) => c.name === 'source')!;
  expect(source.enumValues).toEqual(['upload', 'verify', 'download', 'storage_scan']);
});

test('objects status enum matches schema, defaults to pending', () => {
  const config = getTableConfig(objects);
  const status = config.columns.find((c) => c.name === 'status')!;
  expect(status.enumValues).toEqual(['pending', 'present', 'missing', 'deleted', 'purged']);
  expect(status.default).toBe('pending');
});
