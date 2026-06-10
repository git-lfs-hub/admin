import { Hono } from 'hono';

import type { AppEnv } from '@/_env';
import alertsApi from '@/api/alerts';
import me from '@/api/me';
import reposApi from '@/api/repos';
import storageApi from '@/api/storage';
import { isLocal } from '@/lib/host';
import loginOauth from '@/login/oauth';
import auth from '@/middleware/auth';
import { reconcileAll } from '@/reconcile/index';
import { handleObjectEvents, type ObjectEvent } from '@/server/object-events';
import webhooks from '@/webhooks/index';

export { Registry } from '@/db/registry';
export { Storage } from '@/db/storage';
export { Alerts } from '@/db/alerts';
export { PurgeWorkflow } from '@/workflows/purge';

let devReconcileFired = false;

const app = new Hono<AppEnv>()
  .use('*', async (c, next) => {
    // Dev only (no cron locally): await to completion — the dev runtime truncates
    // waitUntil background tasks, leaving most repos unreconciled.
    if (!devReconcileFired && isLocal(c)) {
      devReconcileFired = true;
      await reconcileAll(c.env, true);
    }
    await next();
  })
  .route('/login/oauth', loginOauth)
  .route('/webhooks', webhooks)
  .use('/api/*', auth)
  .route('/api/me', me)
  .route('/api/repos', reposApi)
  .route('/api/storage', storageApi)
  .route('/api/alerts', alertsApi)
  // Manually kick the cron pass (discovery + reconcile) so a fresh deploy / wiped DO doesn't
  // wait up to an hour for the next cron. Runs in the background; the UI refetches after.
  .post('/api/reconcile', (c) => {
    c.executionCtx.waitUntil(reconcileAll(c.env));
    return c.json({ status: 'reconciling' }, 202);
  })
  .get('*', auth, (c) => c.env.ASSETS.fetch(c.req.raw));

export type AppType = typeof app;

export default {
  fetch: app.fetch,
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(reconcileAll(env));
  },
  async queue(batch, env) {
    await handleObjectEvents(batch as MessageBatch<ObjectEvent>, env);
  },
} satisfies ExportedHandler<CloudflareBindings, ObjectEvent>;
