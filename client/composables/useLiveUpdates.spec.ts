import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent } from 'vue';

import { useLiveUpdates } from '@/composables/useLiveUpdates';

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  url: string;
  onmessage: ((e: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();
  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }
}

let queryClient: QueryClient;
let invalidate: ReturnType<typeof vi.spyOn>;

function mountLive(topics: Record<string, string[][]> = { storage: [['storage'], ['alerts']] }) {
  queryClient = new QueryClient();
  invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue(undefined);
  const Wrapper = defineComponent({
    setup: () => useLiveUpdates(topics),
    render: () => null,
  });
  return mount(Wrapper, { global: { plugins: [[VueQueryPlugin, { queryClient }]] } });
}

const latest = () => MockWebSocket.instances.at(-1)!;

describe('useLiveUpdates', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('opens a WebSocket to /api/live', () => {
    mountLive();
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(latest().url).toMatch(/^wss?:\/\/.*\/api\/live$/);
  });

  it('invalidates a topic’s query keys on its tick', () => {
    mountLive();
    latest().onmessage!({ data: 'storage' });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['storage'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['alerts'] });
  });

  it('ignores ticks for unsubscribed topics', () => {
    mountLive({ repos: [['repos']] });
    latest().onmessage!({ data: 'storage' });
    expect(invalidate).not.toHaveBeenCalled();
    latest().onmessage!({ data: 'repos' });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['repos'] });
  });

  it('reconnects after the socket closes', () => {
    mountLive();
    latest().onclose!();
    expect(MockWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it('resets backoff once a reconnected socket opens', () => {
    mountLive();
    latest().onclose!(); // schedule reconnect at base backoff (1s)
    vi.advanceTimersByTime(1000);
    latest().onopen!(); // open resets backoff
    latest().onclose!(); // next reconnect is back at 1s, not doubled
    vi.advanceTimersByTime(1000);
    expect(MockWebSocket.instances).toHaveLength(3);
  });

  it('an error closes the socket (triggering reconnect)', () => {
    mountLive();
    latest().onerror!();
    expect(latest().close).toHaveBeenCalled();
  });

  it('stops reconnecting once the scope is disposed', () => {
    const wrapper = mountLive();
    wrapper.unmount();
    expect(latest().close).toHaveBeenCalled();
    latest().onclose!();
    vi.advanceTimersByTime(60000);
    expect(MockWebSocket.instances).toHaveLength(1);
  });
});
