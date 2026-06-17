import { test, expect, describe } from 'vitest';

import { isLocalLfsHost } from '@/lib/lfsEndpoint';

const env = (server: string) => ({ LFS: { server } }) as unknown as CloudflareBindings;
const SELF = 'lfs.git-lfs-hub.dev';
const local = (host: string, server = SELF) => isLocalLfsHost(host, env(server));

describe('isLocalLfsHost', () => {
  test('matches this deployment ignoring scheme, case, and default port', () => {
    expect(local('lfs.git-lfs-hub.dev')).toBe(true);
    expect(local('LFS.git-lfs-hub.dev')).toBe(true);
    expect(local('lfs.git-lfs-hub.dev', 'https://lfs.git-lfs-hub.dev:443/x')).toBe(true);
  });

  test('an explicit default port on the configured server normalizes away', () => {
    expect(local('lfs.git-lfs-hub.dev', 'lfs.git-lfs-hub.dev:443')).toBe(true);
  });

  test('non-default port must match', () => {
    expect(local('localhost:8787', 'localhost:8787')).toBe(true);
    expect(local('localhost:9999', 'localhost:8787')).toBe(false);
    expect(local('localhost', 'localhost:8787')).toBe(false);
  });

  test('different host is external', () => {
    expect(local('github.com')).toBe(false);
    expect(local('other.example.com')).toBe(false);
  });

  test('false when env.LFS.server is empty', () => {
    expect(local('lfs.git-lfs-hub.dev', '')).toBe(false);
  });
});
