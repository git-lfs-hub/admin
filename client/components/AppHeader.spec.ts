import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRouter, createMemoryHistory } from 'vue-router';

import AppHeader from '@/components/AppHeader.vue';
import type { Alert } from '@/composables/useAlerts';

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/repos', component: { template: '<div />' } },
      { path: '/storage', component: { template: '<div />' } },
    ],
  });
}

const alert: Alert = {
  kind: 'missing',
  scope: 'alice/repo',
  severity: 'warning',
  detail: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  decision: null,
  decidedAt: null,
  decidedBy: null,
};

// Route the two calls the header makes: /api/me (auth) and /api/alerts (notifications).
function stubFetch({
  alerts = [] as Alert[],
  slackError = null as { message: string; at: string } | null,
} = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | { url: string }) => {
      const url = typeof input === 'string' ? input : input.url;
      const body = url.includes('/alerts') ? { alerts, slackError } : { admin: 'dev' };
      return Promise.resolve({
        ok: true,
        status: 200,
        clone() {
          return this;
        },
        json: () => Promise.resolve(body),
      });
    }),
  );
}

function mountHeader() {
  return mount(AppHeader, {
    global: { plugins: [makeRouter(), [VueQueryPlugin, { queryClient: makeQueryClient() }]] },
  });
}

describe('AppHeader', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows the Storage and Repos section tabs', () => {
    stubFetch();
    const wrapper = mountHeader();
    const tabs = wrapper.findAll('[data-slot="tabs-trigger"]').map((t) => t.text());
    expect(tabs).toEqual(['Storage', 'Repos']);
  });

  it('shows admin username after /api/me resolves', async () => {
    stubFetch();
    const wrapper = mountHeader();
    await flushPromises();
    expect(wrapper.text()).toContain('dev');
  });

  it('reloads via the reconcile button (POSTs /api/reconcile)', async () => {
    vi.useFakeTimers(); // useReconcile schedules a delayed refetch; don't let it dangle
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      clone() {
        return this;
      },
      json: () => Promise.resolve({ admin: 'dev', alerts: [], slackError: null }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mountHeader();
    await flushPromises();

    fetchMock.mockClear();
    await wrapper.find('button[aria-label="Reload"]').trigger('click');
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/reconcile',
      expect.objectContaining({ method: 'POST' }),
    );
    vi.useRealTimers();
  });

  it('carries a notification bell', () => {
    stubFetch();
    const wrapper = mountHeader();
    expect(wrapper.find('button[aria-label="Notifications"]').exists()).toBe(true);
  });

  it('shows the dot only when an alert (or Slack failure) is live', async () => {
    stubFetch();
    const none = mountHeader();
    await flushPromises();
    expect(none.find('[data-slot="notification-dot"]').exists()).toBe(false);
    none.unmount();

    stubFetch({ alerts: [alert] });
    const some = mountHeader();
    await flushPromises();
    expect(some.find('[data-slot="notification-dot"]').exists()).toBe(true);
    some.unmount();

    // A Slack-delivery failure alone still lights the dot.
    stubFetch({ slackError: { message: 'not_in_channel', at: '2026-01-01T00:00:00Z' } });
    const slack = mountHeader();
    await flushPromises();
    expect(slack.find('[data-slot="notification-dot"]').exists()).toBe(true);
    slack.unmount();
  });

  it('opens the notifications popover listing the alerts', async () => {
    stubFetch({ alerts: [alert] });
    const wrapper = mountHeader();
    await flushPromises();
    await wrapper.find('button[aria-label="Notifications"]').trigger('click');
    await flushPromises();
    // PopoverContent teleports into document.body.
    expect(document.body.textContent).toContain('Notifications');
    expect(document.body.querySelector('ul')).not.toBeNull();
    expect(document.body.textContent).toContain('alice/repo');
    wrapper.unmount();
  });

  it('shows the Slack-delivery-failing line in the popover even with zero alerts', async () => {
    stubFetch({ slackError: { message: 'not_in_channel', at: '2026-01-01T00:00:00Z' } });
    const wrapper = mountHeader();
    await flushPromises();
    await wrapper.find('button[aria-label="Notifications"]').trigger('click');
    await flushPromises();
    expect(document.body.textContent).toContain('Slack delivery failing');
    expect(document.body.textContent).toContain('not_in_channel');
    wrapper.unmount();
  });
});
