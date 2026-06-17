import { reset } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, test, expect, afterEach } from 'vitest';

import { Registry } from '@/db/registry';
import { Repo, type LfsconfigParse } from '@/db/repo';

afterEach(async () => {
  await reset();
});

const local = (sha: string, prefix: string): LfsconfigParse => ({
  sha,
  host: env.LFS.server.toLowerCase(),
  prefix,
  local: true,
  status: 'ok',
});

describe('Repo DO', () => {
  test('byRepo keys on lc(owner/repo)', async () => {
    const a = Repo.byRepo(env, 'Alice', 'Repo');
    const b = env.REPO.getByName('alice/repo');
    expect((await a.listBranches()).length).toBe(0);
    // same DO name → same (empty) state, distinct instances notwithstanding
    expect(await b.listBranches()).toEqual([]);
  });

  test('fresh repo has empty branches + lfsconfigs', async () => {
    const repo = Repo.byRepo(env, 'alice', 'a');
    expect(await repo.listBranches()).toEqual([]);
    expect(await repo.listLfsconfigs()).toEqual([]);
    expect(await repo.getBranch('main')).toBeNull();
  });

  test('different owner/repo → isolated state', async () => {
    const a = env.REPO.get(env.REPO.idFromName('alice/a'));
    const b = env.REPO.get(env.REPO.idFromName('bob/b'));
    expect(await a.listBranches()).toEqual([]);
    expect(await b.listBranches()).toEqual([]);
  });

  test('recordHead advances head, preserves lfsconfig columns', async () => {
    const repo = Repo.byRepo(env, 'org', 'r');
    await repo.recordLfsconfig('main', 'c1', local('b1', 'org/r'));
    await repo.recordHead('main', 'c2');
    const [branch] = await repo.listBranches();
    expect(branch).toMatchObject({ headSha: 'c2', lfsconfigSha: 'b1', lfsconfigStatus: 'ok' });
  });
});

describe('Repo.syncLinks → REGISTRY graph', () => {
  const registry = () => Registry.global(env);

  test('local prefix → active link, but no storage row (storage = bytes, not a claim)', async () => {
    const repo = Repo.byRepo(env, 'Org', 'Repo');
    await repo.recordLfsconfig('main', 'c1', local('b1', 'Org/Repo'));
    await repo.syncLinks('Org', 'Repo');

    // The `.lfsconfig` claim is a link only; the prefix becomes storage when objects are discovered.
    expect(await registry().getStorage('Org/Repo')).toBeNull();
    expect(await registry().listLinksForRepo('Org', 'Repo')).toMatchObject([
      { owner: 'org', repo: 'repo', prefix: 'Org/Repo', status: 'active' },
    ]);
  });

  test('external (local=0) prefix → no storage, no link', async () => {
    const repo = Repo.byRepo(env, 'Org', 'Ext');
    await repo.recordLfsconfig('main', 'c1', {
      sha: 'b1',
      host: 'lfs.elsewhere.example',
      prefix: 'Other/Repo',
      local: false,
      status: 'ok',
    });
    await repo.syncLinks('Org', 'Ext');

    expect(await registry().getStorage('Other/Repo')).toBeNull();
    expect(await registry().listLinksForRepo('Org', 'Ext')).toEqual([]);
  });

  test('prefix dropped on a later scan → its link goes stale', async () => {
    const repo = Repo.byRepo(env, 'Org', 'Moved');
    await repo.recordLfsconfig('main', 'c1', local('b1', 'Org/Old'));
    await repo.syncLinks('Org', 'Moved');
    await repo.recordLfsconfig('main', 'c2', local('b2', 'Org/New'));
    await repo.syncLinks('Org', 'Moved');

    const links = await registry().listLinksForRepo('Org', 'Moved');
    expect(links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ prefix: 'Org/Old', status: 'stale' }),
        expect.objectContaining({ prefix: 'Org/New', status: 'active' }),
      ]),
    );
  });
});
