import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, toRaw } from 'vue';

import { useStorage, type StorageRow } from '@/composables/useStorage';

const mockStorage: StorageRow[] = [
  {
    prefix: 'org/test-repo',
    owner: 'org',
    repo: 'test-repo',
    status: 'used',
    name: 'org/test-repo',
    firstSeen: '2026-01-01T00:00:00Z',
    updatedAt: '2026-05-01T00:00:00Z',
    lastChangeAt: null,
    unusedAt: null,
    archivedAt: null,
    backedUpAt: null,
    backupComplete: false,
    clearedAt: null,
    purgedAt: null,
    activeOp: null,
    gitRepo: { owner: 'org', repo: 'test-repo', status: 'active' },
    willArchiveAt: null,
    willPurgeAt: null,
    purgeConfirmBy: null,
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
      return useStorage();
    },
    render() {
      return null;
    },
  });
  return mount(Wrapper, {
    global: { plugins: [[VueQueryPlugin, { queryClient }]] },
  });
}

describe('useStorage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches storage on mount', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      clone() {
        return this;
      },
      json: () => Promise.resolve({ storage: mockStorage }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const wrapper = mountWithQuery();
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/storage',
      expect.objectContaining({ credentials: 'same-origin' }),
    );
    expect(toRaw(wrapper.vm.data)).toEqual(mockStorage);
    expect(wrapper.vm.isLoading).toBe(false);
    expect(wrapper.vm.error).toBeNull();
    wrapper.unmount();
  });

  it('sorts actionable first, purged last, ties by prefix', async () => {
    const row = (o: Partial<StorageRow>): StorageRow => ({ ...mockStorage[0], ...o });
    const unsorted: StorageRow[] = [
      row({ prefix: 'org/used', status: 'used' }),
      row({ prefix: 'org/purged', status: 'purged' }),
      row({ prefix: 'org/b-unused', status: 'unused' }),
      row({ prefix: 'org/purging', status: 'unused', activeOp: 'purge' }),
      row({ prefix: 'org/a-unused', status: 'unused' }),
      row({ prefix: 'org/archived', status: 'used', archivedAt: '2026-05-01T00:00:00Z' }),
    ];
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      clone() {
        return this;
      },
      json: () => Promise.resolve({ storage: unsorted }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const wrapper = mountWithQuery();
    await flushPromises();

    expect((wrapper.vm.data as StorageRow[]).map((r) => r.prefix)).toEqual([
      'org/purging', // in-flight purge — needs a decision
      'org/a-unused', // unused, ties broken alphabetically
      'org/b-unused',
      'org/archived',
      'org/used',
      'org/purged', // terminal — last
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
