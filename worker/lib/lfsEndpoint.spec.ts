import { test, expect, describe } from 'vitest';

import { parseLfsUrl, isLocalLfsHost } from '@/lib/lfsEndpoint';

const env = (server: string) => ({ LFS: { server } }) as unknown as CloudflareBindings;
const SELF = 'lfs.git-lfs-hub.dev';
const local = (host: string, server = SELF) => isLocalLfsHost(host, env(server));
// host as scanLfsconfig sees it: already run through parseLfsUrl.
const hostOf = (url: string) => parseLfsUrl(url)!.host;

describe('parseLfsUrl', () => {
  test('splits host and path, lowercases host, keeps path case', () => {
    expect(parseLfsUrl('https://LFS.git-lfs-hub.dev/lfs/Org/Repo')).toEqual({
      host: 'lfs.git-lfs-hub.dev',
      path: '/lfs/Org/Repo',
    });
  });

  test('drops the scheme’s default port', () => {
    expect(hostOf('https://lfs.git-lfs-hub.dev:443/x')).toBe('lfs.git-lfs-hub.dev');
    expect(hostOf('http://lfs.git-lfs-hub.dev:80/x')).toBe('lfs.git-lfs-hub.dev');
  });

  test('keeps a non-default port', () => {
    expect(hostOf('http://localhost:8787/lfs/o/r')).toBe('localhost:8787');
  });

  test('null for non-http(s) scheme', () => {
    expect(parseLfsUrl('ssh://git@host/o/r')).toBeNull();
  });

  test('null for unparseable / relative url', () => {
    expect(parseLfsUrl('/lfs/o/r')).toBeNull();
    expect(parseLfsUrl('not a url')).toBeNull();
  });
});

describe('isLocalLfsHost', () => {
  test('matches this deployment ignoring scheme, case, and default port', () => {
    expect(local('lfs.git-lfs-hub.dev')).toBe(true);
    expect(local('LFS.git-lfs-hub.dev')).toBe(true);
    expect(local(hostOf('https://lfs.git-lfs-hub.dev:443/lfs/o/r'))).toBe(true);
    expect(local(hostOf('http://LFS.git-lfs-hub.dev/lfs/o/r'))).toBe(true);
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
