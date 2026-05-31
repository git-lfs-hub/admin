import { Hono } from 'hono'
import {
  githubOAuthUrl,
  oauthCallback,
  oauthErrorUrl,
  requireOrgRole,
  setSessionCookie,
} from '@git-lfs-hub/lib/auth'
import { GithubApi } from '@git-lfs-hub/lib/github'
import type { AppEnv } from '@/_env'

const app = new Hono<AppEnv>()

// First-party browser login (not a Git loopback proxy). Shares lib OAuth helpers
// with the server but uses client_state for the post-login path, not oauthSuccessUrl.

// GET /login/oauth/authorize — start
app.get('/authorize', async (c) => {
  const origin = new URL(c.req.url).origin
  const url = await githubOAuthUrl({
    clientId: c.env.GITHUB_CLIENT_ID,
    callbackUrl: `${origin}/login/oauth/callback`,
    secret: c.env.SESSION_SECRET,
    state: {
      redirect_uri: `${origin}/login/oauth/authorize`, // oauthErrorUrl only
      client_state: c.req.query('state') ?? '/repos', // in-app return path after login
      scopes: 'read:org',
    },
  })
  return c.redirect(url, 302)
})

// GET /login/oauth/callback — exchange + cookie
app.get('/callback', async (c) => {
  const { code, state } = c.req.query()
  const result = await oauthCallback({
    code,
    state,
    secret: c.env.SESSION_SECRET,
    clientId: c.env.GITHUB_CLIENT_ID,
    clientSecret: c.env.GITHUB_CLIENT_SECRET,
    callbackUrl: `${new URL(c.req.url).origin}/login/oauth/callback`,
  })
  if (!result.ok) {
    const errUrl = oauthErrorUrl(result)
    if (errUrl) return c.redirect(errUrl, 302)
    return c.text(`OAuth error: ${result.error}`, 400)
  }

  const api = new GithubApi(result.tokenPayload.token)
  const forbidden = await requireOrgRole(api, c.env.GITHUB_ORG, 'admin')
  if (forbidden) return forbidden

  await setSessionCookie(c, result.tokenPayload, c.env.SESSION_SECRET)
  // Browser session cookie is the auth mechanism; no ephemeral code handoff.
  return c.redirect(result.statePayload.client_state, 302)
})

export default app
