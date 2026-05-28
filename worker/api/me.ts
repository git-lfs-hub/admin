import { Hono } from 'hono'
import type { AppEnv } from '@/_env'

const app = new Hono<AppEnv>()
  .get('/', (c) => c.json({ admin: c.var.admin }))

export default app
