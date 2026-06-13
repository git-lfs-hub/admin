import { exports } from 'cloudflare:workers';
import { describe, test, expect } from 'vitest';

describe('GET /api/me', () => {
  test('returns admin username on localhost (dev bypass)', async () => {
    const res = await exports.default.fetch('http://localhost/api/me');
    expect(res.status).toBe(200);
    // Local-dev bypass surfaces every configured org as admin-of (test env: GITHUB_ORG=test-org).
    // coldStorage is off in the test config (GC.coldStorage = "").
    expect(await res.json()).toEqual({ admin: 'dev', orgs: ['test-org'], coldStorage: false });
  });

  test('returns 401 without session cookie on production host', async () => {
    const res = await exports.default.fetch('http://admin.example.com/api/me');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthenticated' });
  });
});
