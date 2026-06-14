import { Hono } from 'hono';
import { describe, test, expect, vi, beforeEach } from 'vitest';

const { mockResolveSession } = vi.hoisted(() => ({ mockResolveSession: vi.fn() }));

// Only resolveSession is mocked; the org-role gate (authorizeOrgRole) runs for real against
// the per-org `api.orgRole` stub below, so adminOrgs is exercised end-to-end.
vi.mock('@git-lfs-hub/lib/auth', async (orig) => ({
  ...(await orig<typeof import('@git-lfs-hub/lib/auth')>()),
  resolveSession: mockResolveSession,
}));

import { GithubError } from '@git-lfs-hub/lib/github';

import auth from '@/middleware/auth';

const ENV = {
  LOGIN_SECRET: 'a'.repeat(64),
  GITHUB_ORG: 'test-org',
  GITHUB_CLIENT_ID: 'test-client-id',
  GITHUB_CLIENT_SECRET: 'test-client-secret',
};

const COOKIE = { Cookie: 'gh_session_v2=anything' };

// `api.orgRole` answers per-org from this map; default makes the caller admin everywhere.
function sessionWithRoles(roles: Record<string, 'admin' | 'member' | null>) {
  return {
    api: { orgRole: async (org: string) => roles[org] ?? null },
    username: 'alice',
  };
}

function createApp() {
  const app = new Hono();
  app.use('*', auth as any);
  const handler = (c: any) => c.json({ admin: c.var.admin, adminOrgs: c.var.adminOrgs });
  app.get('/test', handler);
  app.get('/api/test', handler);
  return app;
}

function req(path: string, host = 'example.com', init: RequestInit = {}, env = ENV) {
  return createApp().request(
    `http://${host}${path}`,
    { ...init, headers: { ...COOKIE, ...(init.headers ?? {}) } },
    env,
  );
}

describe('auth middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveSession.mockResolvedValue(sessionWithRoles({ 'test-org': 'admin' }));
  });

  describe('localhost bypass', () => {
    test('sets admin to "dev" and adminOrgs to all configured orgs', async () => {
      const res = await req('/test', 'localhost');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ admin: 'dev', adminOrgs: ['test-org'] });
    });

    test('sets admin to "dev" for 127.0.0.1', async () => {
      const res = await req('/test', '127.0.0.1');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ admin: 'dev', adminOrgs: ['test-org'] });
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
      expect(await res.json()).toEqual({ admin: 'dev', adminOrgs: ['test-org'] });
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
    test('admits an admin and records the orgs they own', async () => {
      mockResolveSession.mockResolvedValue(
        sessionWithRoles({ 'org-a': 'admin', 'org-b': 'member', 'org-c': 'admin' }),
      );
      const env = { ...ENV, GITHUB_ORG: '', GITHUB_ORGS: 'org-a org-b org-c' };
      const res = await req('/test', 'example.com', {}, env);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ admin: 'alice', adminOrgs: ['org-a', 'org-c'] });
    });

    test('a forbidden org (App not installed) is dropped, not fatal', async () => {
      const forbidden = new GithubError('forbidden', 'membership: 403', 403);
      mockResolveSession.mockResolvedValue({
        api: {
          orgRole: async (org: string) => {
            if (org === 'org-a') throw forbidden;
            return 'admin';
          },
        },
        username: 'alice',
      });
      const env = { ...ENV, GITHUB_ORG: '', GITHUB_ORGS: 'org-a org-b' };
      const res = await req('/test', 'example.com', {}, env);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ admin: 'alice', adminOrgs: ['org-b'] });
    });

    test('admin of none → 403', async () => {
      mockResolveSession.mockResolvedValue(sessionWithRoles({ 'test-org': 'member' }));
      const res = await req('/test');
      expect(res.status).toBe(403);
    });
  });

  // A 401 from GitHub means the session's token is expired/revoked — re-auth, not 500.
  describe('production — token rejected by GitHub (401)', () => {
    function sessionWithDeadToken() {
      const unauthorized = new GithubError('unauthorized', 'membership: 401', 401);
      return {
        api: {
          orgRole: async () => {
            throw unauthorized;
          },
        },
        username: 'alice',
      };
    }

    test('API path returns 401 JSON', async () => {
      mockResolveSession.mockResolvedValue(sessionWithDeadToken());
      const res = await req('/api/test');
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'unauthenticated' });
    });

    test('non-API path redirects to OAuth', async () => {
      mockResolveSession.mockResolvedValue(sessionWithDeadToken());
      const res = await req('/dashboard');
      expect(res.status).toBe(302);
      expect(res.headers.get('Location')).toBe('/login/oauth/authorize?state=%2Fdashboard');
    });

    test('a non-auth GithubError is not swallowed as re-auth (propagates → 500)', async () => {
      const transient = new GithubError('transient', 'membership: 503', 503);
      mockResolveSession.mockResolvedValue({
        api: {
          orgRole: async () => {
            throw transient;
          },
        },
        username: 'alice',
      });
      const res = await req('/test');
      expect(res.status).toBe(500);
    });
  });
});
