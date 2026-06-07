import {
  githubOAuthUrl,
  oauthCallback,
  oauthErrorUrl,
  requireOrgRole,
  setSessionCookie,
} from '@git-lfs-hub/lib/auth';
import { GithubApi } from '@git-lfs-hub/lib/github';
import { Hono } from 'hono';

import type { AppEnv } from '@/_env';

const app = new Hono<AppEnv>();

// First-party browser login (not a Git loopback proxy). Shares lib OAuth helpers
// with the server but uses client_state for the post-login path, not oauthSuccessUrl.
//
// GITHUB_CLIENT_ID/SECRET are the GitHub App's user-to-server OAuth credentials (Group C —
// the admin login and reconciliation share one App; see .plans/.../04.Webhooks.md). The
// authorize/callback endpoints are identical to an OAuth App's; the `scopes` below are
// ignored by GitHub Apps — the org-admin gate (requireOrgRole) instead relies on the App's
// org "Members: read" permission. Token expiry is handled by resolveSession's refresh-token
// rotation (lib/auth).

// GET /login/oauth/authorize — start
app.get('/authorize', async (c) => {
  const origin = new URL(c.req.url).origin;
  const url = await githubOAuthUrl({
    clientId: c.env.GITHUB_CLIENT_ID,
    callbackUrl: `${origin}/login/oauth/callback`,
    secret: c.env.LOGIN_SECRET,
    state: {
      redirect_uri: `${origin}/login/oauth/authorize`, // oauthErrorUrl only
      client_state: c.req.query('state') ?? '/repos', // in-app return path after login
      scopes: 'read:org',
    },
  });
  return c.redirect(url, 302);
});

// GET /login/oauth/callback — exchange + cookie
app.get('/callback', async (c) => {
  const { code, state } = c.req.query();

  const result = await oauthCallback({
    code,
    state,
    secret: c.env.LOGIN_SECRET,
    clientId: c.env.GITHUB_CLIENT_ID,
    clientSecret: c.env.GITHUB_CLIENT_SECRET,
    callbackUrl: `${new URL(c.req.url).origin}/login/oauth/callback`,
  });

  if (!result.ok) {
    if (result.state) return c.redirect(oauthErrorUrl(result.state, result.error), 302);
    return c.text(`OAuth error: ${result.error}`, 400);
  }

  const api = new GithubApi(result.tokens.access);
  const forbidden = await requireOrgRole(api, c.env.GITHUB_ORG, 'admin');
  if (forbidden) return forbidden;

  await setSessionCookie(c, result.tokens, c.env.LOGIN_SECRET);

  // Browser session cookie is the auth mechanism; no ephemeral code handoff.
  return c.redirect(result.state.client_state, 302);
});

export default app;
