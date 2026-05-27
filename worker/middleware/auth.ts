import type { MiddlewareHandler } from 'hono'
import { validateSession, requireOrgRole, SESSION_COOKIE } from '@git-lfs-hub/auth'
import { getCookie } from 'hono/cookie'

const auth: MiddlewareHandler<{ Bindings: CloudflareBindings; Variables: { admin: string } }> = async (c, next) => {
  // Dev bypass: localhost short-circuits to admin='dev'. Hostname is the gate —
  // import.meta.env.DEV is false inside the built worker.
  const host = new URL(c.req.url).hostname
  if (host === 'localhost' || host === '127.0.0.1') {
    c.set('admin', 'dev')
    return next()
  }

  const session = await validateSession(getCookie(c, SESSION_COOKIE), c.env.SESSION_SECRET)
  if (!session) {
    if (c.req.path.startsWith('/api/')) return c.json({ error: 'unauthenticated' }, 401)
    const qs = c.req.url.includes('?') ? '?' + c.req.url.split('?')[1] : ''
    const returnTo = c.req.path + qs
    return c.redirect(`/login/oauth/authorize?state=${encodeURIComponent(returnTo)}`, 302)
  }
  const forbidden = await requireOrgRole(session.token, c.env.GITHUB_ORG, 'admin')
  if (forbidden) return forbidden
  c.set('admin', session.username)
  await next()
}

export default auth
