import { describe, expect, it, vi } from 'vitest';

describe('main entrypoint', () => {
  it('mounts app to #app', async () => {
    const root = document.createElement('div');
    root.id = 'app';
    document.body.appendChild(root);

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ repos: [] }),
      }),
    );
    // The mounted app opens a live-updates WebSocket; stub it so happy-dom doesn't attempt a real
    // connection (and a forever reconnect loop) against a dead URL in this never-unmounted app.
    vi.stubGlobal(
      'WebSocket',
      class {
        close() {}
      },
    );

    await import('@/main');
    expect(root.innerHTML.length).toBeGreaterThan(0);

    document.body.removeChild(root);
  });
});
