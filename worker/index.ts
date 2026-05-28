import { Hono } from 'hono'
import auth from './middleware/auth'
import me from './api/me'
import repos from './api/repos'
import loginOauth from './login/oauth'
import type { AppEnv } from './_env'

export { Repos } from './db/repos'

const app = new Hono<AppEnv>()
  .route('/login/oauth', loginOauth)
  .use('/api/*', auth)
  .route('/api/me', me)
  .route('/api/repos', repos)
  .get('*', auth, (c) => c.env.ASSETS.fetch(c.req.raw))

export type AppType = typeof app
export default app
