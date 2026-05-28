import { Hono } from 'hono'
import { isoAddDays } from '@/lib/time'
import type { AppEnv } from '@/_env'

const app = new Hono<AppEnv>()
  .get('/', async (c) => {
    const stub = c.env.REPOS.get(c.env.REPOS.idFromName('global'))
    const rows = await stub.listAll()
    const graceDays = Number(c.env.GC_PURGE_GRACE_DAYS)
    const repos = rows.map((r) => ({
      ...r,
      objectCount: null as number | null,
      totalSize: null as number | null,
      willPurgeAt: r.deletedAt ? isoAddDays(r.deletedAt, graceDays) : null,
    }))
    return c.json({ repos })
  })

export default app
