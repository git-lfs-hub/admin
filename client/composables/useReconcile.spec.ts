import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent } from 'vue';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('vue-sonner', () => ({ toast }));

const post = vi.hoisted(() => vi.fn());
vi.mock('@/api', () => ({ api: { api: { reconcile: { $post: post } } } }));

import { useReconcile } from '@/composables/useReconcile';

function mountWithQuery() {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
  const Wrapper = defineComponent({
    setup() {
      return useReconcile();
    },
    render() {
      return null;
    },
  });
  const wrapper = mount(Wrapper, { global: { plugins: [[VueQueryPlugin, { queryClient }]] } });
  return { wrapper, invalidate };
}

describe('useReconcile', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    post.mockReset();
    toast.success.mockReset();
    toast.error.mockReset();
  });

  it('POSTs reconcile, toasts, and invalidates the lists after the delay', async () => {
    vi.useFakeTimers();
    post.mockResolvedValueOnce({ ok: true });

    const { wrapper, invalidate } = mountWithQuery();
    await wrapper.vm.mutateAsync();

    expect(post).toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith('Reconcile started — refreshing shortly');
    expect(invalidate).not.toHaveBeenCalled();

    vi.advanceTimersByTime(4000);
    for (const key of ['storage', 'repos', 'alerts']) {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: [key] });
    }
    wrapper.unmount();
  });

  it('toasts the error message when the POST fails', async () => {
    post.mockRejectedValueOnce(new Error('reconcile down'));

    const { wrapper } = mountWithQuery();
    await expect(wrapper.vm.mutateAsync()).rejects.toThrow('reconcile down');
    await flushPromises();

    expect(toast.error).toHaveBeenCalledWith('reconcile down');
    wrapper.unmount();
  });
});
