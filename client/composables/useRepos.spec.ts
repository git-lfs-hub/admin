import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, toRaw } from 'vue';

import { useRepos, type RepoRow } from '@/composables/useRepos';

const mockRepos: RepoRow[] = [
  {
    owner: 'org',
    repo: 'test-repo',
    status: 'active',
    name: 'org/test-repo',
    firstSeen: '2026-01-01T00:00:00Z',
    updatedAt: '2026-05-01T00:00:00Z',
    missingAt: null,
    archivedAt: null,
    backedUpAt: null,
    backupComplete: false,
    clearedAt: null,
    purgedAt: null,
    activeOp: null,
    willArchiveAt: null,
    willPurgeAt: null,
    lastAccessedAt: null,
    usage: {
      deleted: { count: 0, size: 0 },
      missing: { count: 0, size: 0 },
      pending: { count: 0, size: 0 },
      present: { count: 10, size: 1024 },
      purged: { count: 0, size: 0 },
    },
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
