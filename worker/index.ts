import { Hono } from 'hono'
import auth from '@/middleware/auth'
import me from '@/api/me'
import reposApi from '@/api/repos'
import loginOauth from '@/login/oauth'
import { discoverRepos } from '@/r2/discovery'
import { reconcileRepos } from '@/reconcile/index'
import { handleObjectEvents, type ObjectEvent } from '@/server/object-events'
import type { AppEnv } from '@/_env'

export { Repos } from '@/db/repos'

let devDiscoveryFired = false

const app = new Hono<AppEnv>()
  .use('*', async (c, next) => {
    if (!devDiscoveryFired) {
      const host = new URL(c.req.url).hostname
      if (host === 'localhost' || host === '127.0.0.1') {
        devDiscoveryFired = true
        const repos = c.env.REPOS.get(c.env.REPOS.idFromName('global'))
        c.executionCtx.waitUntil(discoverRepos(c.env.LFS_BUCKET, repos))
      }
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
    const repos = env.REPOS.get(env.REPOS.idFromName('global'))
    ctx.waitUntil((async () => {
      await discoverRepos(env.LFS_BUCKET, repos)
      await reconcileRepos(env, repos)
    })())
  },
  async queue(batch, env) {
    await handleObjectEvents(batch as MessageBatch<ObjectEvent>, env)
  },
} satisfies ExportedHandler<CloudflareBindings, ObjectEvent>
