import { requireOrgRole, resolveSession } from '@git-lfs-hub/lib/auth';
import type { MiddlewareHandler } from 'hono';
import type { Context } from 'hono';

import type { AppEnv } from '@/_env';
import { isLocal } from '@/lib/host';

const auth: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (isLocal(c)) {
    c.set('admin', 'dev');
    return next();
  }

  const session = await resolveSession(c, {
    secret: c.env.LOGIN_SECRET,
    clientId: c.env.GITHUB_CLIENT_ID,
    clientSecret: c.env.GITHUB_CLIENT_SECRET,
  });

  if (!session) return unauthenticated(c);
  const { api, username } = session;

  const forbidden = await requireOrgRole(api, c.env.GITHUB_ORG, 'admin');
  if (forbidden) return forbidden;

  c.set('admin', username);
  await next();
};

function unauthenticated(c: Context<AppEnv>) {
  if (c.req.path.startsWith('/api/')) return c.json({ error: 'unauthenticated' }, 401);
  const qs = c.req.url.includes('?') ? '?' + c.req.url.split('?')[1] : '';
  const returnTo = c.req.path + qs;
  return c.redirect(`/login/oauth/authorize?state=${encodeURIComponent(returnTo)}`, 302);
}

export default auth;
