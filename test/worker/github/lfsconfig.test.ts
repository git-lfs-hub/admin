import { reset } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, test, expect, afterEach, vi } from 'vitest';

import { Repo } from '@/db/repo';
import { scanLfsconfig, type ScanRef } from '@/github/lfsconfig';

afterEach(async () => {
  await reset();
});

const LOCAL = env.LFS.server; // this deployment's host
const repo = () => Repo.byRepo(env, 'Org', 'Repo');
const ref = (branch: string, headSha: string): ScanRef => ({
  owner: 'Org',
  name: 'Repo',
  branch,
  headSha,
});
const lfsconfig = (url: string) => `[lfs]\n\turl = ${url}\n`;

// commits: ref(=headSha) → { blob?: blobSha }. A ref with no blob models an absent .lfsconfig
// (getContent 404). blobs: blobSha → raw text. Identical content → identical blob sha, so two
// commits sharing content share a blob key (content-addressed, like git). fail → transient error.
function fakeApi(
  commits: Record<string, { blob?: string }>,
  blobs: Record<string, string> = {},
  fail = false,
) {
  const getContent = vi.fn(async ({ ref }: { ref: string }) => {
    if (fail) throw { status: 500 };
    const blob = commits[ref]?.blob;
    if (!blob) throw { status: 404 };
    return {
      data: { type: 'file', sha: blob, content: btoa(blobs[blob] ?? ''), encoding: 'base64' },
    };
  });
  const api = { octokit: { rest: { repos: { getContent } } } } as never;
  return { api, getContent };
}

describe('scanLfsconfig — parse states', () => {
  test('ok local: one getContent call, records branch + parse cache, classifies local', async () => {
    const { api, getContent } = fakeApi(
      { c1: { blob: 'b1' } },
      { b1: lfsconfig(`https://${LOCAL}/lfs/Org/Repo`) },
    );
    expect(await scanLfsconfig(api, repo(), env, ref('main', 'c1'))).toBe('ok');
    expect(getContent).toHaveBeenCalledTimes(1);

    const [branch] = await repo().listBranches();
    expect(branch).toMatchObject({
      branch: 'main',
      headSha: 'c1',
      lfsconfigSha: 'b1',
      lfsconfigStatus: 'ok',
    });
    const [cfg] = await repo().listLfsconfigs();
    expect(cfg).toMatchObject({
      sha: 'b1',
      host: LOCAL.toLowerCase(),
      prefix: 'Org/Repo',
      local: true,
      status: 'ok',
    });
  });

  test('ok external: local = 0, still recorded', async () => {
    const { api } = fakeApi(
      { c1: { blob: 'b1' } },
      { b1: lfsconfig('https://lfs.elsewhere.example/lfs/Other/Repo') },
    );
    expect(await scanLfsconfig(api, repo(), env, ref('main', 'c1'))).toBe('ok');
    const [cfg] = await repo().listLfsconfigs();
    expect(cfg).toMatchObject({
      host: 'lfs.elsewhere.example',
      prefix: 'Other/Repo',
      local: false,
    });
  });

  test('missing: .lfsconfig absent (404) → missing row, no parse cache', async () => {
    const { api } = fakeApi({ c1: {} });
    expect(await scanLfsconfig(api, repo(), env, ref('main', 'c1'))).toBe('missing');
    const [branch] = await repo().listBranches();
    expect(branch).toMatchObject({ headSha: 'c1', lfsconfigSha: null, lfsconfigStatus: 'missing' });
    expect(await repo().listLfsconfigs()).toEqual([]);
  });

  test('parse_error: unparseable .lfsconfig → cached parse_error', async () => {
    const { api } = fakeApi({ c1: { blob: 'b1' } }, { b1: 'garbage, no lfs url' });
    expect(await scanLfsconfig(api, repo(), env, ref('main', 'c1'))).toBe('parse_error');
    const [branch] = await repo().listBranches();
    expect(branch.lfsconfigStatus).toBe('parse_error');
    const [cfg] = await repo().listLfsconfigs();
    expect(cfg).toMatchObject({ sha: 'b1', prefix: '', status: 'parse_error' });
  });

  test('strips a trailing /info/lfs and .git from the prefix', async () => {
    const { api } = fakeApi(
      { c1: { blob: 'b1' } },
      { b1: lfsconfig(`https://${LOCAL}/lfs/Org/Repo.git/info/lfs`) },
    );
    expect(await scanLfsconfig(api, repo(), env, ref('main', 'c1'))).toBe('ok');
    expect((await repo().listLfsconfigs())[0].prefix).toBe('Org/Repo');
  });

  test('parse_error when the url has no owner/repo path', async () => {
    const { api } = fakeApi({ c1: { blob: 'b1' } }, { b1: lfsconfig(`https://${LOCAL}/lfs`) });
    expect(await scanLfsconfig(api, repo(), env, ref('main', 'c1'))).toBe('parse_error');
  });

  test('unreachable: transient GitHub error leaves the branch row untouched', async () => {
    const { api } = fakeApi({ c1: { blob: 'b1' } }, {}, true);
    expect(await scanLfsconfig(api, repo(), env, ref('main', 'c1'))).toBe('unreachable');
    expect(await repo().listBranches()).toEqual([]);
    expect(await repo().listLfsconfigs()).toEqual([]);
  });
});

describe('scanLfsconfig — dedup', () => {
  test('layer 1: unchanged head → zero GitHub calls', async () => {
    const blobs = { b1: lfsconfig(`https://${LOCAL}/lfs/Org/Repo`) };
    await scanLfsconfig(fakeApi({ c1: { blob: 'b1' } }, blobs).api, repo(), env, ref('main', 'c1'));

    const again = fakeApi({ c1: { blob: 'b1' } }, blobs);
    expect(await scanLfsconfig(again.api, repo(), env, ref('main', 'c1'))).toBe('unchanged');
    expect(again.getContent).not.toHaveBeenCalled();
  });

  test('head moves, blob content identical → branch head advances, one lfsconfigs row', async () => {
    const blobs = { b1: lfsconfig(`https://${LOCAL}/lfs/Org/Repo`) };
    await scanLfsconfig(fakeApi({ c1: { blob: 'b1' } }, blobs).api, repo(), env, ref('main', 'c1'));

    // identical content ⇒ same blob sha b1, fetched again under the new head
    await scanLfsconfig(fakeApi({ c2: { blob: 'b1' } }, blobs).api, repo(), env, ref('main', 'c2'));
    const [branch] = await repo().listBranches();
    expect(branch).toMatchObject({ headSha: 'c2', lfsconfigSha: 'b1' });
    expect(await repo().listLfsconfigs()).toHaveLength(1);
  });

  test('two branches, same blob → two branch rows, one lfsconfigs row', async () => {
    const blobs = { b1: lfsconfig(`https://${LOCAL}/lfs/Org/Repo`) };
    await scanLfsconfig(fakeApi({ c1: { blob: 'b1' } }, blobs).api, repo(), env, ref('main', 'c1'));
    await scanLfsconfig(fakeApi({ c2: { blob: 'b1' } }, blobs).api, repo(), env, ref('dev', 'c2'));
    expect(await repo().listBranches()).toHaveLength(2);
    expect(await repo().listLfsconfigs()).toHaveLength(1);
  });
});
