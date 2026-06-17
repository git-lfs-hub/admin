import { test, expect, describe } from 'vitest';

import { parseLfsUrl } from '@/github/lfsconfig';

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
