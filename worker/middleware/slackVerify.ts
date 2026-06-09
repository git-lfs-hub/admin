import type { MiddlewareHandler } from 'hono';

import type { AppEnv } from '@/_env';
import { verifySlackRequest } from '@/alerts/slack';

// Gate inbound Slack callbacks on the request signature (no GitHub session). Reads the raw body
// — Hono caches it, so the handler's `c.req.text()` returns the same bytes the HMAC covered.
export const slackVerify: MiddlewareHandler<AppEnv> = async (c, next) => {
  const ok = await verifySlackRequest(
    c.env.SLACK_SIGNING_SECRET,
    c.req.header('X-Slack-Request-Timestamp'),
    c.req.header('X-Slack-Signature'),
    await c.req.text(),
    Math.floor(Date.now() / 1000),
  );
  if (!ok) return c.text('invalid signature', 401);
  await next();
};
