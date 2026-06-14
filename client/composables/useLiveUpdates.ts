import { useQueryClient } from '@tanstack/vue-query';
import { onScopeDispose } from 'vue';

// Hold one WebSocket to `/api/live` open; each server tick is a topic ('storage' | 'repos') whose
// table changed, so invalidate that topic's query keys. The REGISTRY DO broadcasts to every socket,
// so we filter by topic here. Reconnects with capped backoff so a dropped socket self-heals.
export function useLiveUpdates(topics: Record<string, string[][]>) {
  const qc = useQueryClient();
  const refetch = (topic: string) => {
    for (const queryKey of topics[topic] ?? []) qc.invalidateQueries({ queryKey });
  };

  let ws: WebSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let backoff = 1000;
  let closed = false;

  const connect = () => {
    ws = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/api/live`);
    ws.onmessage = (e) => refetch(e.data as string);
    ws.onopen = () => (backoff = 1000);
    ws.onerror = () => ws?.close();
    ws.onclose = () => {
      if (closed) return; // disposed — don't resurrect the socket
      retry = setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 30000);
    };
  };

  connect();

  onScopeDispose(() => {
    closed = true;
    clearTimeout(retry);
    ws?.close();
  });
}
