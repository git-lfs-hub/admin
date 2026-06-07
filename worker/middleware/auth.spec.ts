import { Hono } from 'hono';
import { describe, test, expect, vi, beforeEach } from 'vitest';

const { mockResolveSession, mockRequireOrgRole } = vi.hoisted(() => ({
  mockResolveSession: vi.fn(),
  mockRequireOrgRole: vi.fn(),
}));

vi.mock('@git-lfs-hub/lib/auth', async (orig) => ({
  ...(await orig<typeof import('@git-lfs-hub/lib/auth')>()),
  resolveSession: mockResolveSession,
  requireOrgRole: mockRequireOrgRole,
}));

import auth from '@/middleware/auth';

const ENV = {
  LOGIN_SECRET: 'a'.repeat(64),
  GITHUB_ORG: 'test-org',
  GITHUB_CLIENT_ID: 'test-client-id',
  GITHUB_CLIENT_SECRET: 'test-client-secret',
};

const COOKIE = { Cookie: 'gh_session_v2=anything' };

function createApp() {
  const app = new Hono();
  app.use('*', auth as any);
  app.get('/test', (c) => c.json({ admin: (c as any).var.admin }));
  app.get('/api/test', (c) => c.json({ admin: (c as any).var.admin }));
  return app;
}

function req(path: string, host = 'example.com', init: RequestInit = {}) {
  return createApp().request(
    `http://${host}${path}`,
    { ...init, headers: { ...COOKIE, ...(init.headers ?? {}) } },
    ENV,
  );
}

describe('auth middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveSession.mockResolvedValue({ api: {}, username: 'alice' });
    mockRequireOrgRole.mockResolvedValue(null);
  });

  describe('localhost bypass', () => {
    test('sets admin to "dev" for localhost', async () => {
      const res = await req('/test', 'localhost');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ admin: 'dev' });
    });

    test('sets admin to "dev" for 127.0.0.1', async () => {
      const res = await req('/test', '127.0.0.1');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ admin: 'dev' });
    });

    test('does not call resolveSession', async () => {
      await req('/test', 'localhost');
      expect(mockResolveSession).not.toHaveBeenCalled();
    });

    test('ENV=local bypasses auth on a non-local host', async () => {
      const res = await createApp().request(
        'http://example.com/test',
        { headers: COOKIE },
        { ...ENV, ENV: 'local' },
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ admin: 'dev' });
      expect(mockResolveSession).not.toHaveBeenCalled();
    });
  });

  describe('production — no session', () => {
    test('API path returns 401 JSON', async () => {
      mockResolveSession.mockResolvedValue(null);
      const res = await req('/api/test');
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'unauthenticated' });
    });

    test('non-API path redirects to OAuth', async () => {
      mockResolveSession.mockResolvedValue(null);
      const res = await req('/dashboard');
      expect(res.status).toBe(302);
      expect(res.headers.get('Location')).toBe('/login/oauth/authorize?state=%2Fdashboard');
    });

    test('preserves query string in redirect', async () => {
      mockResolveSession.mockResolvedValue(null);
      const res = await req('/repos?page=2');
      expect(res.status).toBe(302);
      expect(res.headers.get('Location')).toBe('/login/oauth/authorize?state=%2Frepos%3Fpage%3D2');
    });

    test('invalid session → redirect', async () => {
      mockResolveSession.mockResolvedValue(null);
      const res = await req('/dashboard');
      expect(res.status).toBe(302);
    });
  });

  describe('production — valid session', () => {
    test('sets admin to GitHub login', async () => {
      mockResolveSession.mockResolvedValue({ api: {}, username: 'alice' });
      const res = await req('/test');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ admin: 'alice' });
    });

    test('returns forbidden when org role check fails', async () => {
      mockRequireOrgRole.mockResolvedValue(new Response('Forbidden', { status: 403 }));
      const res = await req('/test');
      expect(res.status).toBe(403);
    });
  });
});
