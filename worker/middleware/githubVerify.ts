import { verifyWebhookSignature } from '@git-lfs-hub/lib/auth';
import type { MiddlewareHandler } from 'hono';

import type { AppEnv } from '@/_env';

// Gate inbound GitHub webhooks on the `X-Hub-Signature-256` HMAC (no session). Reads the raw
// body — Hono caches it, so the handler's `c.req.text()` returns the same bytes the HMAC covered.
export const githubVerify: MiddlewareHandler<AppEnv> = async (c, next) => {
  const ok = await verifyWebhookSignature(
    await c.req.text(),
    c.req.header('X-Hub-Signature-256'),
    c.env.GITHUB_WEBHOOK_SECRET,
  );
  if (!ok) return c.text('invalid signature', 401);
  await next();
};
