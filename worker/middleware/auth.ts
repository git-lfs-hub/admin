import type { MiddlewareHandler } from 'hono'
import type { Context } from 'hono'
import {
  requireOrgRole,
  getSessionCookie,
  setSessionCookie,
  type SessionPayload,
} from '@git-lfs-hub/lib/auth'
import { GithubApi, githubAccessToken } from '@git-lfs-hub/lib/github'
import type { AppEnv } from '@/_env'

const auth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const host = new URL(c.req.url).hostname
  if (host === 'localhost' || host === '127.0.0.1') {
    c.set('admin', 'dev')
    return next()
  }

  const cookie = await getSessionCookie(c, c.env.SESSION_SECRET)
  if (!cookie) return unauthenticated(c)

  let api = new GithubApi(cookie.token)
  let username = await api.authenticatedUsername()

  if (!username && cookie.refresh_token) {
    const data = await githubAccessToken({
      grant_type: 'refresh_token',
      client_id: c.env.GITHUB_CLIENT_ID,
      client_secret: c.env.GITHUB_CLIENT_SECRET,
      refresh_token: cookie.refresh_token,
    })
    if (data.error || !data.access_token) return unauthenticated(c)

    const payload: SessionPayload = {
      token: data.access_token,
      refresh_token: data.refresh_token || cookie.refresh_token,
    }
    api = new GithubApi(payload.token)
    username = await api.authenticatedUsername()
    if (!username) return unauthenticated(c)
    await setSessionCookie(c, payload, c.env.SESSION_SECRET)
  }

  if (!username) return unauthenticated(c)

  const forbidden = await requireOrgRole(api, c.env.GITHUB_ORG, 'admin')
  if (forbidden) return forbidden
  c.set('admin', username)
  await next()
}

function unauthenticated(c: Context<AppEnv>) {
  if (c.req.path.startsWith('/api/')) return c.json({ error: 'unauthenticated' }, 401)
  const qs = c.req.url.includes('?') ? '?' + c.req.url.split('?')[1] : ''
  const returnTo = c.req.path + qs
  return c.redirect(`/login/oauth/authorize?state=${encodeURIComponent(returnTo)}`, 302)
}

export default auth
