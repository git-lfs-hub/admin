import type { Context } from 'hono';

import type { AppEnv } from '@/_env';

/** Local dev request: loopback host or `ENV=local`. */
export function isLocal(c: Context<AppEnv>): boolean {
  return isLocalHost(new URL(c.req.url).hostname) || (c.env.ENV as string) === 'local';
}

/** True for loopback hosts (URL.hostname renders IPv6 with brackets). */
function isLocalHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}
