import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, toRaw } from 'vue';

import { useAlerts, type Alert } from '@/composables/useAlerts';

const mockAlerts: Alert[] = [
  {
    kind: 'missing',
    scope: 'alice/repo',
    severity: 'warning',
    detail: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    decision: null,
    decidedAt: null,
    decidedBy: null,
  },
];

const fetchMock = vi.fn();

function mountWithQuery() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = defineComponent({
    setup: () => useAlerts(),
    render: () => null,
  });
  return mount(Wrapper, { global: { plugins: [[VueQueryPlugin, { queryClient }]] } });
}

describe('useAlerts', () => {
  afterEach(() => vi.restoreAllMocks());

  it('fetches alerts on mount', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      clone() {
        return this;
      },
      json: () => Promise.resolve({ alerts: mockAlerts, slackError: null }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const wrapper = mountWithQuery();
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/alerts',
      expect.objectContaining({ credentials: 'same-origin' }),
    );
    expect(toRaw(wrapper.vm.data)).toEqual({ alerts: mockAlerts, slackError: null });
    wrapper.unmount();
  });
});
