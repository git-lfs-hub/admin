import { Hono } from 'hono'
import {
  buildAuthorizeUrl,
  signState,
  processOAuthCallback,
  buildOAuthErrorRedirectUrl,
  requireOrgRole,
  SESSION_COOKIE,
  SESSION_COOKIE_OPTIONS,
} from '@git-lfs-hub/auth'
import { setCookie } from 'hono/cookie'

const app = new Hono<{ Bindings: CloudflareBindings }>()

// GET /login/oauth/authorize — start
app.get('/authorize', async (c) => {
  const origin = new URL(c.req.url).origin
  const callbackUrl = `${origin}/login/oauth/callback`
  const returnTo = c.req.query('state') ?? '/repos'
  const state = await signState(
    { redirect_uri: `${origin}/login/oauth/authorize`, client_state: returnTo, scopes: 'read:org' },
    c.env.SESSION_SECRET,
  )
  return c.redirect(buildAuthorizeUrl(c.env.GITHUB_CLIENT_ID, callbackUrl, state, { scope: 'read:org' }), 302)
})

// GET /login/oauth/callback — exchange + cookie
app.get('/callback', async (c) => {
  const code = c.req.query('code')
  const state = c.req.query('state')
  if (!code || !state) return c.text('Bad request', 400)

  const result = await processOAuthCallback({
    code,
    state,
    secret: c.env.SESSION_SECRET,
    clientId: c.env.GITHUB_CLIENT_ID,
    clientSecret: c.env.GITHUB_CLIENT_SECRET,
    callbackUrl: `${new URL(c.req.url).origin}/login/oauth/callback`,
  })

  if (!result.ok) {
    if (result.statePayload) {
      return c.redirect(buildOAuthErrorRedirectUrl(result.error, result.statePayload), 302)
    }
    return c.text(`OAuth error: ${result.error}`, 400)
  }

  const forbidden = await requireOrgRole(result.tokenPayload.token, c.env.GITHUB_ORG, 'admin')
  if (forbidden) return forbidden

  setCookie(c, SESSION_COOKIE, result.encrypted, SESSION_COOKIE_OPTIONS)
  return c.redirect(result.statePayload.client_state, 302)
})

export default app
