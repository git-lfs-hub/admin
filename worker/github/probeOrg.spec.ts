import { GithubError, GithubOrgApi } from '@git-lfs-hub/lib/github';
import { test, expect, vi, beforeEach, describe } from 'vitest';

import { probeOrg } from '@/github/probeOrg';

function mkOrgApi(org = 'alice') {
  return new GithubOrgApi('t', org);
}

function node(owner: string, name: string) {
  return {
    name,
    owner: { login: owner },
    defaultBranchRef: { name: 'main', target: { oid: 'h' } },
    object: null,
  };
}

// `scanRepos` posts to the GraphQL endpoint; octokit.graphql returns the `data` field. A 200
// carries `{ data }`; an error status carries the raw body (octokit throws by HTTP status).
function gqlPage(nodes: unknown[], hasNextPage = false, endCursor: string | null = null) {
  return gql({
    rateLimit: { remaining: 5000 },
    repositoryOwner: { repositories: { pageInfo: { endCursor, hasNextPage }, nodes } },
  });
}

function gql(data: unknown) {
  const res = new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  Object.defineProperty(res, 'url', { value: 'https://api.github.com/graphql' });
  return res;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('probeOrg — success', () => {
  test('200 with rows → active, lowercased key set + scans', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(gqlPage([node('Alice', 'Foo'), node('alice', 'bar')])),
    );
    const r = await probeOrg(mkOrgApi('alice'));
    expect(r.status).toBe('active');
    expect(r.activeRepos).toEqual(new Set(['alice/foo', 'alice/bar']));
    expect(r.scans).toHaveLength(2);
  });

  test('walks pages via the GraphQL cursor', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(gqlPage([node('a', '1')], true, 'c1'))
      .mockResolvedValueOnce(gqlPage([node('a', '2')]));
    vi.stubGlobal('fetch', fetchMock);
    const r = await probeOrg(mkOrgApi('a'));
    expect(r.activeRepos).toEqual(new Set(['a/1', 'a/2']));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('probeOrg — listing failure propagates (caller classifies)', () => {
  test('403 → throws GithubError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 403 })));
    await expect(probeOrg(mkOrgApi('a'))).rejects.toBeInstanceOf(GithubError);
  });

  test('404 → throws GithubError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 404 })));
    await expect(probeOrg(mkOrgApi('a'))).rejects.toBeInstanceOf(GithubError);
  });

  test('5xx → throws GithubError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 502 })));
    await expect(probeOrg(mkOrgApi('a'))).rejects.toBeInstanceOf(GithubError);
  });

  test('network reject → propagates as GithubError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNRESET')));
    await expect(probeOrg(mkOrgApi('a'))).rejects.toBeInstanceOf(GithubError);
  });

  test('owner with no repos → transient_error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(gqlPage([])));
    expect((await probeOrg(mkOrgApi('a'))).status).toBe('transient_error');
  });
});
