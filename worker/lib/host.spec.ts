import { test, expect } from 'vitest';

import { isLocal } from '@/lib/host';

const ctx = (host: string, env = '') =>
  ({ req: { url: `http://${host}/api/repos` }, env: { ENV: env } }) as any;

test('loopback hosts are local', () => {
  for (const h of ['localhost', '127.0.0.1', '[::1]']) {
    expect(isLocal(ctx(h))).toBe(true);
  }
});

test('non-loopback hosts are not local', () => {
  for (const h of ['example.com', '10.0.0.1', 'admin.git-lfs-hub.dev']) {
    expect(isLocal(ctx(h))).toBe(false);
  }
});

test('ENV=local is local on a non-loopback host', () => {
  expect(isLocal(ctx('example.com', 'local'))).toBe(true);
});
