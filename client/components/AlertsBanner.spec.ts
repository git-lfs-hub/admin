import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import AlertsBanner from '@/components/AlertsBanner.vue';
import type { Alert } from '@/composables/useAlerts';

const alerts: Alert[] = [
  {
    kind: 'missing',
    scope: 'alice/repo',
    severity: 'warning',
    detail: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
];

function stubFetch(payload: Alert[], slackError: { message: string; at: string } | null = null) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    clone() {
      return this;
    },
    json: () => Promise.resolve({ alerts: payload, slackError }),
  });
  vi.stubGlobal('fetch', fetchMock);
}

function mountBanner() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return mount(AlertsBanner, { global: { plugins: [[VueQueryPlugin, { queryClient }]] } });
}

describe('AlertsBanner', () => {
  afterEach(() => vi.restoreAllMocks());

  it('hidden when there are no alerts', async () => {
    stubFetch([]);
    const wrapper = mountBanner();
    await flushPromises();
    expect(wrapper.text()).toBe('');
    wrapper.unmount();
  });

  it('shows the count, expands the panel on click, and dismisses', async () => {
    stubFetch(alerts);
    const wrapper = mountBanner();
    await flushPromises();

    expect(wrapper.text()).toContain('1 notification');
    expect(wrapper.find('ul').exists()).toBe(false);

    // toggle open → panel (a <ul> list) renders
    await wrapper.find('button[type="button"]').trigger('click');
    expect(wrapper.find('ul').exists()).toBe(true);

    // dismiss → banner gone
    await wrapper.findAll('button').at(-1)!.trigger('click');
    expect(wrapper.text()).toBe('');
    wrapper.unmount();
  });

  it('shows a Slack-delivery-failing line even with zero alerts', async () => {
    stubFetch([], { message: 'not_in_channel', at: '2026-01-01T00:00:00Z' });
    const wrapper = mountBanner();
    await flushPromises();
    expect(wrapper.text()).toContain('Slack delivery failing');
    expect(wrapper.text()).toContain('not_in_channel');
    wrapper.unmount();
  });
});
