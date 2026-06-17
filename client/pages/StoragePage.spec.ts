import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRouter, createMemoryHistory } from 'vue-router';

import type { StorageRow } from '@/composables/useStorage';
import StoragePage from '@/pages/StoragePage.vue';

const row: StorageRow = {
  prefix: 'org/my-repo',
  owner: 'org',
  repo: 'my-repo',
  status: 'used',
  name: 'org/my-repo',
  firstSeen: '2026-01-15T00:00:00Z',
  updatedAt: '2026-05-24T12:00:00Z',
  lastChangeAt: null,
  unusedAt: null,
  archivedAt: null,
  backedUpAt: null,
  backupComplete: false,
  clearedAt: null,
  purgedAt: null,
  activeOp: null,
  gitRepos: [{ owner: 'org', repo: 'my-repo', status: 'active' }],
  willArchiveAt: null,
  willPurgeAt: null,
  purgeConfirmBy: null,
  lastAccessedAt: null,
  usage: {
    deleted: { count: 0, size: 0 },
    missing: { count: 0, size: 0 },
    pending: { count: 0, size: 0 },
    present: { count: 42, size: 2048 },
    purged: { count: 0, size: 0 },
  },
};

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/repos', component: { template: '<div />' } },
      { path: '/storage', component: { template: '<div />' } },
    ],
  });
}

function mountPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return mount(StoragePage, {
    global: { plugins: [makeRouter(), [VueQueryPlugin, { queryClient }]] },
  });
}

function okResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    clone() {
      return this;
    },
    json: () => Promise.resolve(body),
  };
}

function errResponse(status: number, statusText: string, body: unknown) {
  return {
    ok: false,
    status,
    statusText,
    clone() {
      return { json: () => Promise.resolve(body) };
    },
    json: () => Promise.resolve(body),
  };
}

const fetchMock = vi.fn();

describe('StoragePage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders empty state when no prefixes', async () => {
    vi.stubGlobal('fetch', fetchMock.mockResolvedValue(okResponse({ storage: [] })));
    const wrapper = mountPage();
    await flushPromises();
    expect(wrapper.text()).toContain('No storage discovered yet.');
  });

  it('renders error alert on fetch failure', async () => {
    vi.stubGlobal(
      'fetch',
      fetchMock.mockResolvedValue(errResponse(500, 'Internal Server Error', { error: 'db down' })),
    );
    const wrapper = mountPage();
    await flushPromises();
    expect(wrapper.text()).toContain('Failed to load');
    expect(wrapper.text()).toContain('db down');
  });

  it('renders the storage table when prefixes exist', async () => {
    vi.stubGlobal('fetch', fetchMock.mockResolvedValue(okResponse({ storage: [row] })));
    const wrapper = mountPage();
    await flushPromises();
    expect(wrapper.text()).toContain('org/my-repo');
  });
});
