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

    await import('@/main');
    expect(root.innerHTML.length).toBeGreaterThan(0);

    document.body.removeChild(root);
  });
});
