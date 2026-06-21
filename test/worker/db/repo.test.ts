import { reset } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, test, expect, afterEach } from 'vitest';

import { Registry } from '@/db/registry';
import { Repo, type LfsConfig } from '@/db/repo';

afterEach(async () => {
  await reset();
});

const local = (sha: string, prefix: string): LfsConfig => ({
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

  test('recordLfsconfig upserts the branch lfsconfig columns', async () => {
    const repo = Repo.byRepo(env, 'org', 'r');
    await repo.recordLfsconfig('main', 'c1', local('b1', 'org/r'));
    await repo.recordLfsconfig('main', 'c2', local('b2', 'org/r'));
    const [branch] = await repo.listBranches();
    expect(branch).toMatchObject({ headSha: 'c2', lfsconfigSha: 'b2', lfsconfigStatus: 'ok' });
  });
});

describe('Repo branch lifecycle + ref_paths', () => {
  test('markDirty inserts a dirty active tip; setTip clears it', async () => {
    const repo = Repo.byRepo(env, 'org', 'life');
    await repo.markDirty('feat', 'c1');
    expect(await repo.getBranch('feat')).toMatchObject({
      headSha: 'c1',
      dirty: true,
      status: 'active',
      treeSha: null,
      scannedAt: null,
    });
    await repo.setTip('feat', { headSha: 'c2', treeSha: 't2', gitattrSha: 'g2' });
    const row = await repo.getBranch('feat');
    expect(row).toMatchObject({ headSha: 'c2', treeSha: 't2', gitattrSha: 'g2', dirty: false });
    expect(row?.scannedAt).not.toBeNull();
  });

  test('markBranchMissing / markBranchActive flip status', async () => {
    const repo = Repo.byRepo(env, 'org', 'miss');
    await repo.setTip('gone', { headSha: 'c1', treeSha: 't1', gitattrSha: null });
    await repo.markBranchMissing('gone');
    expect(await repo.getBranch('gone')).toMatchObject({ status: 'missing' });
    expect((await repo.getBranch('gone'))?.missingAt).not.toBeNull();
    await repo.markBranchActive('gone');
    expect(await repo.getBranch('gone')).toMatchObject({ status: 'active', missingAt: null });
  });

  test('replaceRefPaths is wholesale; applyRefPathsDelta upserts + removes', async () => {
    const repo = Repo.byRepo(env, 'org', 'rp');
    await repo.replaceRefPaths('main', [
      { oid: 'o1', path: 'a.bin' },
      { oid: 'o2', path: 'b.bin' },
    ]);
    expect(await repo.listRefPaths('main')).toEqual(
      expect.arrayContaining([
        { oid: 'o1', path: 'a.bin' },
        { oid: 'o2', path: 'b.bin' },
      ]),
    );
    await repo.applyRefPathsDelta('main', [{ oid: 'o3', path: 'c.bin' }], ['a.bin']);
    const rows = await repo.listRefPaths('main');
    expect(rows).toEqual(
      expect.arrayContaining([
        { oid: 'o2', path: 'b.bin' },
        { oid: 'o3', path: 'c.bin' },
      ]),
    );
    expect(rows.find((r) => r.path === 'a.bin')).toBeUndefined();
  });

  test('cleanBranchAtTree finds a sibling; copyRefPaths clones it', async () => {
    const repo = Repo.byRepo(env, 'org', 'sib');
    await repo.setTip('main', { headSha: 'c1', treeSha: 'shared', gitattrSha: null });
    await repo.replaceRefPaths('main', [{ oid: 'o1', path: 'a.bin' }]);
    expect(await repo.cleanBranchAtTree('shared', 'feat')).toBe('main');
    expect(await repo.cleanBranchAtTree('shared', 'main')).toBeNull();
    await repo.copyRefPaths('main', 'feat');
    expect(await repo.listRefPaths('feat')).toEqual([{ oid: 'o1', path: 'a.bin' }]);
  });

  test('pointer + gitattributes caches round-trip (incl. negative entry)', async () => {
    const repo = Repo.byRepo(env, 'org', 'cache');
    await repo.putPointers([
      { sha: 'b1', oid: 'o1', size: 10 },
      { sha: 'b2', oid: null, size: null },
    ]);
    const hits = await repo.getPointers(['b1', 'b2', 'b3']);
    expect(hits.get('b1')).toEqual({ sha: 'b1', oid: 'o1', size: 10 });
    expect(hits.get('b2')).toEqual({ sha: 'b2', oid: null, size: null });
    expect(hits.has('b3')).toBe(false);
    await repo.putGitattributes('g1', '*.bin filter=lfs');
    expect(await repo.getGitattributes('g1')).toBe('*.bin filter=lfs');
    expect(await repo.getGitattributes('g9')).toBeNull();
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
