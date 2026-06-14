import { authorizeOrgRole, orgsFromEnv, resolveSession } from '@git-lfs-hub/lib/auth';
import { GithubError } from '@git-lfs-hub/lib/github';
import type { MiddlewareHandler } from 'hono';
import type { Context } from 'hono';

import type { AppEnv } from '@/_env';
import { isLocal } from '@/lib/host';

const auth: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (isLocal(c)) {
    c.set('admin', 'dev');
    c.set('adminOrgs', [...new Set(orgsFromEnv(c.env))]);
    return next();
  }

  const session = await resolveSession(c, {
    secret: c.env.LOGIN_SECRET,
    clientId: c.env.GITHUB_CLIENT_ID,
    clientSecret: c.env.GITHUB_CLIENT_SECRET,
    cache: c.env.GITHUB_CACHE,
  });

  if (!session) return unauthenticated(c);
  const { api, username } = session;

  // Record which orgs the caller admins — mutations are scoped to them (api/storage.ts).
  // Dedupe: config derives both GITHUB_ORG and GITHUB_ORGS, so an org can appear twice.
  let result: string[] | Response;
  try {
    result = await authorizeOrgRole(api, orgsFromEnv(c.env), 'admin');
  } catch (e) {
    // GitHub rejected the session's token (401): it's expired/revoked, so re-auth rather than
    // 500. resolveSession can't catch this — the token only fails on first real API use.
    if (e instanceof GithubError && e.code === 'unauthorized') return unauthenticated(c);
    throw e;
  }
  if (result instanceof Response) return result;
  const adminOrgs = [...new Set(result)];

  c.set('admin', username);
  c.set('adminOrgs', adminOrgs);
  c.set('api', api);
  await next();
};

function unauthenticated(c: Context<AppEnv>) {
  if (c.req.path.startsWith('/api/')) return c.json({ error: 'unauthenticated' }, 401);
  const qs = c.req.url.includes('?') ? '?' + c.req.url.split('?')[1] : '';
  const returnTo = c.req.path + qs;
  return c.redirect(`/login/oauth/authorize?state=${encodeURIComponent(returnTo)}`, 302);
}

export default auth;
