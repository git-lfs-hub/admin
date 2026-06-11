import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent } from 'vue';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('vue-sonner', () => ({ toast }));

import { useStorageMutations } from '@/composables/useStorageMutations';

const fetchMock = vi.fn();

function mountWithQuery() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
  const Wrapper = defineComponent({
    setup() {
      return useStorageMutations();
    },
    render() {
      return null;
    },
  });
  const wrapper = mount(Wrapper, { global: { plugins: [[VueQueryPlugin, { queryClient }]] } });
  return { wrapper, invalidate };
}

describe('useStorageMutations', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    fetchMock.mockReset();
    toast.success.mockReset();
    toast.error.mockReset();
  });

  it('archive POSTs, toasts success, invalidates the storage and alerts queries', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      clone() {
        return this;
      },
      json: () => Promise.resolve({ storage: { archivedAt: '2026-05-25T00:00:00Z' } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { wrapper, invalidate } = mountWithQuery();
    await wrapper.vm.archive.mutateAsync({ owner: 'alice', repo: 'gone' });
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/storage/alice/gone/archive',
      expect.objectContaining({ method: 'POST', credentials: 'same-origin' }),
    );
    expect(toast.success).toHaveBeenCalledWith('Archived alice/gone');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['storage'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['alerts'] });
    wrapper.unmount();
  });

  it('restore POSTs, toasts success, invalidates the storage query', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      clone() {
        return this;
      },
      json: () => Promise.resolve({ storage: { archivedAt: null } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { wrapper, invalidate } = mountWithQuery();
    await wrapper.vm.restore.mutateAsync({ owner: 'alice', repo: 'gone' });
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/storage/alice/gone/restore',
      expect.objectContaining({ method: 'POST', credentials: 'same-origin' }),
    );
    expect(toast.success).toHaveBeenCalledWith('Restored alice/gone');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['storage'] });
    wrapper.unmount();
  });

  const okJson = (body: unknown) => ({
    ok: true,
    status: 200,
    clone() {
      return this;
    },
    json: () => Promise.resolve(body),
  });

  it('purge previews then POSTs the confirm token, toasts, invalidates', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ token: 'tok', impact: { objects: 1 } }));
    fetchMock.mockResolvedValueOnce(okJson({ status: 'purging' }));
    vi.stubGlobal('fetch', fetchMock);

    const { wrapper, invalidate } = mountWithQuery();
    await wrapper.vm.purge.mutateAsync({ owner: 'alice', repo: 'gone' });
    await flushPromises();

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/storage/alice/gone/purge/preview',
      expect.objectContaining({ method: 'POST' }),
    );
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe('/api/storage/alice/gone/purge');
    expect(JSON.parse(init.body)).toEqual({ token: 'tok' });
    expect(toast.success).toHaveBeenCalledWith('Purge started for alice/gone');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['storage'] });
    wrapper.unmount();
  });

  it('confirmWorkflow POSTs to workflow/confirm', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ status: 'confirmed' }));
    vi.stubGlobal('fetch', fetchMock);

    const { wrapper, invalidate } = mountWithQuery();
    await wrapper.vm.confirmWorkflow.mutateAsync({ owner: 'alice', repo: 'gone' });
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/storage/alice/gone/workflow/confirm',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(toast.success).toHaveBeenCalledWith('Confirmed purge for alice/gone');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['storage'] });
    wrapper.unmount();
  });

  it('cancelWorkflow POSTs to workflow/cancel', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ status: 'cancelled' }));
    vi.stubGlobal('fetch', fetchMock);

    const { wrapper, invalidate } = mountWithQuery();
    await wrapper.vm.cancelWorkflow.mutateAsync({ owner: 'alice', repo: 'gone' });
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/storage/alice/gone/workflow/cancel',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(toast.success).toHaveBeenCalledWith('Cancelled purge for alice/gone');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['storage'] });
    wrapper.unmount();
  });

  it('toasts the server error message on failure', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      statusText: 'Conflict',
      clone() {
        return { json: () => Promise.resolve({ error: 'invalid_state' }) };
      },
      json: () => Promise.resolve({ error: 'invalid_state' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { wrapper } = mountWithQuery();
    await expect(wrapper.vm.archive.mutateAsync({ owner: 'alice', repo: 'live' })).rejects.toThrow(
      'invalid_state',
    );
    await flushPromises();

    expect(toast.error).toHaveBeenCalledWith('invalid_state');
    expect(toast.success).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});
