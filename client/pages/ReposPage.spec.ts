import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRouter, createMemoryHistory } from 'vue-router';

import type { RepoRow } from '@/composables/useRepos';
import ReposPage from '@/pages/ReposPage.vue';

const repo: RepoRow = {
  owner: 'org',
  repo: 'my-repo',
  name: 'org/my-repo',
  status: 'active',
  firstSeen: '2026-01-15T00:00:00Z',
  updatedAt: '2026-05-24T12:00:00Z',
  missingAt: null,
  storage: { prefix: 'org/my-repo', status: 'used', archivedAt: null },
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
  return mount(ReposPage, {
    global: { plugins: [makeRouter(), [VueQueryPlugin, { queryClient }]] },
  });
}

function okResponse(body: unknown) {
  const res = {
    ok: true,
    status: 200,
    clone() {
      return this;
    },
    json: () => Promise.resolve(body),
  };
  return res;
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

describe('ReposPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders empty state when no repos', async () => {
    vi.stubGlobal('fetch', fetchMock.mockResolvedValue(okResponse({ repos: [] })));
    const wrapper = mountPage();
    await flushPromises();
    expect(wrapper.text()).toContain('No repositories discovered yet.');
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

  it('renders loading skeletons initially', () => {
    vi.stubGlobal('fetch', fetchMock.mockReturnValue(new Promise(() => {})));
    const wrapper = mountPage();
    expect(wrapper.findAll('[class*="skeleton"], [data-slot="skeleton"]').length).toBeGreaterThan(
      0,
    );
  });

  it('renders repo table when repos exist', async () => {
    vi.stubGlobal('fetch', fetchMock.mockResolvedValue(okResponse({ repos: [repo] })));
    const wrapper = mountPage();
    await flushPromises();
    expect(wrapper.text()).toContain('org/my-repo');
    expect(wrapper.text()).toContain('active');
  });
});
