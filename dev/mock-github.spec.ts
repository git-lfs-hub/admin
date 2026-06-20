import { mockGithubApp, devScans } from '@dev/mock-github';
import { describe, test, expect } from 'vitest';

const env = { LFS: { server: 'lfs.test' }, GITHUB_ORG: 'test-org', GITHUB_ORGS: '' } as any;

describe('mockGithubApp', () => {
  test('installs the primary allowed org (GITHUB_ORGS/GITHUB_ORG)', async () => {
    expect(await mockGithubApp(env).installedOrgs()).toEqual([{ login: 'test-org', id: 1 }]);
  });

  test('no allowed org → no installations', async () => {
    const app = mockGithubApp({ LFS: { server: 'lfs.test' } } as any);
    expect(await app.installedOrgs()).toEqual([]);
  });

  test('orgApi sweep yields the fixture repos under the org', async () => {
    const orgApi = await mockGithubApp(env).orgApi({ login: 'test-org', id: 1 });
    const pages: Awaited<ReturnType<typeof devScans>>[] = [];
    for await (const page of orgApi.scanRepos()) pages.push(page);
    expect(pages).toHaveLength(1);
    expect(pages[0].map((s) => `${s.owner}/${s.name}`)).toEqual([
      'test-org/webapp',
      'test-org/mobile-app',
      'test-org/marketing-site',
      'test-org/marketing-app',
      'test-org/legacy',
    ]);
  });
});

describe('devScans', () => {
  test('maps a linked repo to a local `.lfsconfig` scan on `main`', () => {
    const [scan] = devScans(env, 'test-org', ['webapp'], { webapp: 'shared' });
    expect(scan).toEqual({
      owner: 'test-org',
      name: 'webapp',
      branch: 'main',
      headSha: 'dev-head-test-org/webapp',
      lfsconfig: {
        oid: 'dev-oid-test-org/shared',
        text: '[lfs]\n\turl = https://lfs.test/lfs/test-org/shared\n',
      },
    });
  });

  test('two repos sharing a prefix get the same blob oid (one cached `.lfsconfig`)', () => {
    const scans = devScans(env, 'test-org', ['webapp', 'mobile'], {
      webapp: 'shared',
      mobile: 'shared',
    });
    expect(scans[0].lfsconfig?.oid).toBe(scans[1].lfsconfig?.oid);
  });

  test('a repo with no link has no `.lfsconfig` (→ unused prefix)', () => {
    const [scan] = devScans(env, 'test-org', ['orphan'], {});
    expect(scan.lfsconfig).toBeNull();
  });
});
