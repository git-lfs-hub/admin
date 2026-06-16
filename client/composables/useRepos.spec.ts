import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, toRaw } from 'vue';

import { useRepos, type RepoRow } from '@/composables/useRepos';

const mockRepos: RepoRow[] = [
  {
    owner: 'org',
    repo: 'test-repo',
    name: 'org/test-repo',
    status: 'active',
    firstSeen: '2026-01-01T00:00:00Z',
    updatedAt: '2026-05-01T00:00:00Z',
    missingAt: null,
    storage: { prefix: 'org/test-repo', status: 'used', archivedAt: null },
  },
];

const fetchMock = vi.fn();

function mountWithQuery() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = defineComponent({
    setup() {
      return useRepos();
    },
    render() {
      return null;
    },
  });
  return mount(Wrapper, {
    global: { plugins: [[VueQueryPlugin, { queryClient }]] },
  });
}

describe('useRepos', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches repos on mount', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      clone() {
        return this;
      },
      json: () => Promise.resolve({ repos: mockRepos }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const wrapper = mountWithQuery();
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/repos',
      expect.objectContaining({ credentials: 'same-origin' }),
    );
    expect(toRaw(wrapper.vm.data)).toEqual(mockRepos);
    expect(wrapper.vm.isLoading).toBe(false);
    expect(wrapper.vm.error).toBeNull();
    wrapper.unmount();
  });

  it('sorts missing-with-storage first, storage-less last, ties by owner/repo', async () => {
    const row = (o: Partial<RepoRow>): RepoRow => ({ ...mockRepos[0], ...o });
    const unsorted: RepoRow[] = [
      row({ owner: 'org', repo: 'no-storage', status: 'active', storage: null }),
      row({ owner: 'org', repo: 'b-active', status: 'active' }),
      row({ owner: 'org', repo: 'missing', status: 'missing' }),
      row({ owner: 'org', repo: 'missing-gone', status: 'missing', storage: null }),
      row({
        owner: 'org',
        repo: 'missing-purged',
        status: 'missing',
        storage: { prefix: 'org/missing-purged', status: 'purged', archivedAt: null },
      }),
      row({ owner: 'org', repo: 'a-active', status: 'active' }),
    ];
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      clone() {
        return this;
      },
      json: () => Promise.resolve({ repos: unsorted }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const wrapper = mountWithQuery();
    await flushPromises();

    expect((wrapper.vm.data as RepoRow[]).map((r) => `${r.owner}/${r.repo}`)).toEqual([
      'org/missing', // problem — repo gone, storage now unused
      'org/a-active', // active w/ storage, ties broken alphabetically
      'org/b-active',
      'org/missing-gone', // missing but no storage — nothing to act on, sinks with the noise
      'org/missing-purged', // missing and storage already purged — nothing left, sinks too
      'org/no-storage', // no storage — noise, last
    ]);
    wrapper.unmount();
  });

  it('sets error on fetch failure', async () => {
    const errBody = { error: 'db down' };
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      clone() {
        return { json: () => Promise.resolve(errBody) };
      },
      json: () => Promise.resolve(errBody),
    });
    vi.stubGlobal('fetch', fetchMock);

    const wrapper = mountWithQuery();
    await flushPromises();

    expect(wrapper.vm.error).toBeInstanceOf(Error);
    expect((wrapper.vm.error as Error).message).toBe('db down');
    expect(wrapper.vm.isLoading).toBe(false);
    wrapper.unmount();
  });
});
