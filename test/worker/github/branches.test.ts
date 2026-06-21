import { reset } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, test, expect, afterEach, vi } from 'vitest';

import { Repo } from '@/db/repo';
import { applyPushEvent, resolveBranch, type BranchPushEvent } from '@/github/branches';

afterEach(async () => {
  await reset();
});

const ptr = (oid: string) =>
  `version https://git-lfs.github.com/spec/v1\noid sha256:${oid.padEnd(64, '0')}\nsize 9\n`;

// Mock GithubOrgApi. `listBlobs` (a lib method, unit-tested in lib) returns the tip tree's blob
// entries directly; `getBlobs` supplies their text.
function mockApi(over: Partial<Record<string, any>> = {}) {
  return {
    listBlobs: vi.fn(async () => []),
    getBlobs: vi.fn(async () => new Map()),
    getFile: vi.fn(async () => null),
    compare: vi.fn(async () => ({ status: 'identical', files: [], totalCommits: 0 })),
    ...over,
  } as any;
}

function treeApi(gitattributes: string, blobs: Record<string, string>) {
  const entries = [
    { path: '.gitattributes', type: 'blob', sha: 'ga' },
    ...Object.keys(blobs).map((path) => ({ path, type: 'blob', sha: `sha-${path}` })),
  ];
  return mockApi({
    listBlobs: vi.fn(async () => entries),
    getBlobs: vi.fn(async (_repo: string, oids: string[]) => {
      const m = new Map<string, { text: string | null }>();
      for (const o of oids) {
        if (o === 'ga') m.set(o, { text: gitattributes });
        const path = o.replace('sha-', '');
        if (blobs[path]) m.set(o, { text: blobs[path] });
      }
      return m;
    }),
  });
}

const push = (over: Partial<BranchPushEvent>): BranchPushEvent => ({
  repo: 'r',
  branch: 'main',
  before: '',
  after: 'c1',
  treeSha: 't1',
  forced: false,
  addedModified: [],
  removed: [],
  ...over,
});

describe('resolveBranch (first sight / full resolve)', () => {
  test('reads the tip tree, indexes only matching LFS pointers', async () => {
    const repo = Repo.byRepo(env, 'org', 'res');
    const api = treeApi('*.bin filter=lfs', { 'a.bin': ptr('aaa'), 'b.txt': 'plain' });
    const out = await resolveBranch(api, repo, 'main', { headSha: 'c1', treeSha: 't1' });
    expect(out).toBe('resolved');
    expect(await repo.listRefPaths('main')).toEqual([
      { oid: 'aaa'.padEnd(64, '0'), path: 'a.bin' },
    ]);
    expect(await repo.getBranch('main')).toMatchObject({ treeSha: 't1', dirty: false });
  });

  test('tree_sha unchanged → 0 GitHub calls', async () => {
    const repo = Repo.byRepo(env, 'org', 'noop');
    const api = treeApi('*.bin filter=lfs', { 'a.bin': ptr('aaa') });
    await resolveBranch(api, repo, 'main', { headSha: 'c1', treeSha: 't1' });
    const api2 = treeApi('*.bin filter=lfs', { 'a.bin': ptr('aaa') });
    const out = await resolveBranch(api2, repo, 'main', { headSha: 'c1', treeSha: 't1' });
    expect(out).toBe('unchanged');
    expect(api2.listBlobs).not.toHaveBeenCalled();
  });

  test('sibling at same tree → copy, 0 GitHub calls', async () => {
    const repo = Repo.byRepo(env, 'org', 'sib');
    const api = treeApi('*.bin filter=lfs', { 'a.bin': ptr('aaa') });
    await resolveBranch(api, repo, 'main', { headSha: 'c1', treeSha: 'shared' });
    const api2 = mockApi();
    const out = await resolveBranch(api2, repo, 'feat', { headSha: 'c1', treeSha: 'shared' });
    expect(out).toBe('copied');
    expect(api2.listBlobs).not.toHaveBeenCalled();
    expect(await repo.listRefPaths('feat')).toEqual([
      { oid: 'aaa'.padEnd(64, '0'), path: 'a.bin' },
    ]);
  });

  test('blob-sha cache hit: a later resolve refetches no blobs', async () => {
    const repo = Repo.byRepo(env, 'org', 'cache');
    await resolveBranch(treeApi('*.bin filter=lfs', { 'a.bin': ptr('aaa') }), repo, 'main', {
      headSha: 'c1',
      treeSha: 't1',
    });
    // New tree sha, same blob sha for a.bin → pointer cache hit, gitattributes cache hit.
    const api = treeApi('*.bin filter=lfs', { 'a.bin': ptr('aaa') });
    await resolveBranch(api, repo, 'feat', { headSha: 'c2', treeSha: 't2' });
    expect(api.getBlobs).not.toHaveBeenCalled();
  });

  test('oversized matched blob is negative-cached, never fetched (size prefilter)', async () => {
    const repo = Repo.byRepo(env, 'org', 'big');
    const getBlobs = vi.fn(async (_r: string, oids: string[]) => {
      const m = new Map<string, { text: string | null }>();
      for (const o of oids) if (o === 'ga') m.set(o, { text: '*.bin filter=lfs' });
      return m;
    });
    const api = mockApi({
      listBlobs: vi.fn(async () => [
        { path: '.gitattributes', type: 'blob', sha: 'ga', size: 20 },
        { path: 'real.bin', type: 'blob', sha: 'sha-real', size: 5_000_000 },
      ]),
      getBlobs,
    });
    await resolveBranch(api, repo, 'main', { headSha: 'c1', treeSha: 't1' });
    const fetched = getBlobs.mock.calls.flatMap((c) => c[1] as string[]);
    expect(fetched).not.toContain('sha-real');
    expect(await repo.listRefPaths('main')).toEqual([]);
    expect((await repo.getPointers(['sha-real'])).get('sha-real')).toEqual({
      sha: 'sha-real',
      oid: null,
      size: null,
    });
  });

  test('unfetchable .gitattributes (null blob) → empty filter, nothing tracked', async () => {
    const repo = Repo.byRepo(env, 'org', 'ganull');
    const api = mockApi({
      listBlobs: vi.fn(async () => [
        { path: '.gitattributes', type: 'blob', sha: 'ga' },
        { path: 'a.bin', type: 'blob', sha: 'sha-a' },
      ]),
      getBlobs: vi.fn(async (_r: string, oids: string[]) => {
        const m = new Map<string, { text: string | null }>();
        for (const o of oids) if (o === 'ga') m.set(o, { text: null });
        return m;
      }),
    });
    await resolveBranch(api, repo, 'main', { headSha: 'c1', treeSha: 't1' });
    expect(await repo.listRefPaths('main')).toEqual([]);
  });

  test('a partial/failed tree read leaves the branch dirty, ref_paths untouched', async () => {
    const repo = Repo.byRepo(env, 'org', 'fail');
    const api = mockApi({
      listBlobs: vi.fn(async () => {
        throw new Error('rate limited');
      }),
    });
    const out = await resolveBranch(api, repo, 'main', { headSha: 'c1', treeSha: 't1' });
    expect(out).toBe('dirty');
    expect(await repo.getBranch('main')).toMatchObject({ dirty: true });
    expect(await repo.listRefPaths('main')).toEqual([]);
  });
});

describe('applyPushEvent state machine', () => {
  async function seed(repoName: string, blobs: Record<string, string>) {
    const repo = Repo.byRepo(env, 'org', repoName);
    await applyPushEvent(
      () => treeApi('*.bin filter=lfs', blobs),
      repo,
      push({ after: 'c1', treeSha: 't1' }),
    );
    return repo;
  }

  test('first sight → full resolve', async () => {
    const repo = await seed('fs', { 'a.bin': ptr('aaa') });
    expect((await repo.listRefPaths('main')).length).toBe(1);
  });

  test('sequential delta: adds a new pointer, drops a removed path', async () => {
    const repo = await seed('seq', { 'a.bin': ptr('aaa') });
    const api = mockApi({
      getFile: vi.fn(async () => ({ sha: 'sha-b.bin', text: ptr('bbb') })),
    });
    const out = await applyPushEvent(
      () => api,
      repo,
      push({
        before: 'c1',
        after: 'c2',
        treeSha: 't2',
        addedModified: ['b.bin'],
        removed: ['a.bin'],
      }),
    );
    expect(out).toBe('delta');
    expect(await repo.listRefPaths('main')).toEqual([
      { oid: 'bbb'.padEnd(64, '0'), path: 'b.bin' },
    ]);
  });

  test('sequential with no matching path changed → 0 GitHub calls', async () => {
    const repo = await seed('seq0', { 'a.bin': ptr('aaa') });
    const api = mockApi();
    const out = await applyPushEvent(
      () => api,
      repo,
      push({ before: 'c1', after: 'c2', treeSha: 't2', addedModified: ['readme.md'] }),
    );
    expect(out).toBe('delta');
    expect(api.getFile).not.toHaveBeenCalled();
    expect((await repo.listRefPaths('main')).length).toBe(1);
  });

  test('sequential delta: a candidate whose file is gone (getFile null) is dropped', async () => {
    const repo = await seed('seqgone', { 'a.bin': ptr('aaa') });
    const api = mockApi({ getFile: vi.fn(async () => null) });
    const out = await applyPushEvent(
      () => api,
      repo,
      push({ before: 'c1', after: 'c2', treeSha: 't2', addedModified: ['b.bin'] }),
    );
    expect(out).toBe('delta');
    expect((await repo.listRefPaths('main')).map((r) => r.path)).toEqual(['a.bin']);
  });

  test('sequential delta: a candidate that no longer parses as a pointer is dropped', async () => {
    const repo = await seed('seqnonptr', { 'a.bin': ptr('aaa') });
    const api = mockApi({
      getFile: vi.fn(async () => ({ sha: 'sha-plain', text: 'just a plain file' })),
    });
    const out = await applyPushEvent(
      () => api,
      repo,
      push({ before: 'c1', after: 'c2', treeSha: 't2', addedModified: ['a.bin'] }),
    );
    expect(out).toBe('delta');
    expect(await repo.listRefPaths('main')).toEqual([]);
  });

  test('sequential delta: a cached pointer blob is not re-parsed from text', async () => {
    const repo = await seed('seqcache', { 'a.bin': ptr('aaa') });
    const api = mockApi({
      getFile: vi.fn(async () => ({ sha: 'sha-a.bin', text: 'IRRELEVANT — cache wins' })),
    });
    const out = await applyPushEvent(
      () => api,
      repo,
      push({ before: 'c1', after: 'c2', treeSha: 't2', addedModified: ['a.bin'] }),
    );
    expect(out).toBe('delta');
    expect((await repo.listRefPaths('main')).map((r) => r.oid)).toEqual(['aaa'.padEnd(64, '0')]);
  });

  test('compare reports a rename → dirty (capped diff cannot be trusted)', async () => {
    const repo = await seed('rename', { 'a.bin': ptr('aaa') });
    const api = mockApi({
      compare: vi.fn(async () => ({
        status: 'ahead',
        files: [{ filename: 'b.bin', status: 'renamed' }],
        totalCommits: 1,
      })),
    });
    const out = await applyPushEvent(
      () => api,
      repo,
      push({ before: 'STALE', after: 'c3', treeSha: 't3' }),
    );
    expect(out).toBe('dirty');
  });

  test('compare gap touching .gitattributes → dirty (filter may have changed)', async () => {
    const repo = await seed('gapga', { 'a.bin': ptr('aaa') });
    const api = mockApi({
      compare: vi.fn(async () => ({
        status: 'ahead',
        files: [{ filename: '.gitattributes', status: 'modified' }],
        totalCommits: 1,
      })),
    });
    const out = await applyPushEvent(
      () => api,
      repo,
      push({ before: 'STALE', after: 'c3', treeSha: 't3' }),
    );
    expect(out).toBe('dirty');
  });

  test('forward gap → compare delta', async () => {
    const repo = await seed('gap', { 'a.bin': ptr('aaa') });
    const api = mockApi({
      compare: vi.fn(async () => ({
        status: 'ahead',
        files: [{ filename: 'b.bin', status: 'added' }],
        totalCommits: 2,
      })),
      getFile: vi.fn(async () => ({ sha: 'sha-b.bin', text: ptr('bbb') })),
    });
    const out = await applyPushEvent(
      () => api,
      repo,
      push({ before: 'STALE', after: 'c3', treeSha: 't3' }),
    );
    expect(out).toBe('delta');
    expect(api.compare).toHaveBeenCalled();
    expect((await repo.listRefPaths('main')).map((r) => r.path)).toContain('b.bin');
  });

  test('compare reports diverged → dirty (defer to resolve)', async () => {
    const repo = await seed('div', { 'a.bin': ptr('aaa') });
    const api = mockApi({
      compare: vi.fn(async () => ({ status: 'diverged', files: [], totalCommits: 1 })),
    });
    const out = await applyPushEvent(
      () => api,
      repo,
      push({ before: 'STALE', after: 'c3', treeSha: 't3' }),
    );
    expect(out).toBe('dirty');
    expect(await repo.getBranch('main')).toMatchObject({ dirty: true, headSha: 'c3' });
  });

  test('force push → dirty', async () => {
    const repo = await seed('force', { 'a.bin': ptr('aaa') });
    const out = await applyPushEvent(
      () => mockApi(),
      repo,
      push({ before: 'c1', after: 'c9', treeSha: 't9', forced: true }),
    );
    expect(out).toBe('dirty');
  });

  test('.gitattributes touched → dirty (filter may have changed)', async () => {
    const repo = await seed('ga', { 'a.bin': ptr('aaa') });
    const out = await applyPushEvent(
      () => mockApi(),
      repo,
      push({ before: 'c1', after: 'c2', treeSha: 't2', addedModified: ['.gitattributes'] }),
    );
    expect(out).toBe('dirty');
  });

  test('recreated branch (zero before) re-resolves and flips active', async () => {
    const repo = await seed('recreate', { 'a.bin': ptr('aaa') });
    await repo.markBranchMissing('main');
    const out = await applyPushEvent(
      () => treeApi('*.bin filter=lfs', { 'a.bin': ptr('aaa'), 'b.bin': ptr('bbb') }),
      repo,
      push({ before: '0'.repeat(40), after: 'c5', treeSha: 't5' }),
    );
    expect(out).toBe('resolved');
    expect(await repo.getBranch('main')).toMatchObject({ status: 'active', dirty: false });
    expect((await repo.listRefPaths('main')).map((r) => r.path).sort()).toEqual(['a.bin', 'b.bin']);
  });

  test('stale/out-of-order webhook (compare behind) → noop', async () => {
    const repo = await seed('stale', { 'a.bin': ptr('aaa') });
    const api = mockApi({
      compare: vi.fn(async () => ({ status: 'behind', files: [], totalCommits: 0 })),
    });
    const out = await applyPushEvent(
      () => api,
      repo,
      push({ before: 'OLD', after: 'c0', treeSha: 't0' }),
    );
    expect(out).toBe('noop');
  });
});
