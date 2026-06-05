import { Hono } from 'hono'
import auth from '@/middleware/auth'
import me from '@/api/me'
import reposApi from '@/api/repos'
import loginOauth from '@/login/oauth'
import { reconcileAll } from '@/reconcile/index'
import { handleObjectEvents, type ObjectEvent } from '@/server/object-events'
import { isLocal } from '@/lib/host'
import type { AppEnv } from '@/_env'

export { Repos } from '@/db/repos'
export { RepoIndex } from '@/db/repo-index'

let devReconcileFired = false

const app = new Hono<AppEnv>()
  .use('*', async (c, next) => {
    // Dev only (no cron locally): await to completion — the dev runtime truncates
    // waitUntil background tasks, leaving most repos unreconciled.
    if (!devReconcileFired && isLocal(c)) {
      devReconcileFired = true
      await reconcileAll(c.env, true)
    }
    await next()
  })
  .route('/login/oauth', loginOauth)
  .use('/api/*', auth)
  .route('/api/me', me)
  .route('/api/repos', reposApi)
  .get('*', auth, (c) => c.env.ASSETS.fetch(c.req.raw))

export type AppType = typeof app

export default {
  fetch: app.fetch,
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(reconcileAll(env))
  },
  async queue(batch, env) {
    await handleObjectEvents(batch as MessageBatch<ObjectEvent>, env)
  },
} satisfies ExportedHandler<CloudflareBindings, ObjectEvent>
