import { Hono } from 'hono'
import { isoAddDays } from '@/lib/time'
import type { AppEnv } from '@/_env'

const app = new Hono<AppEnv>()
  .get('/', async (c) => {
    const stub = c.env.REPOS.get(c.env.REPOS.idFromName('global'))
    const rows = await stub.listAll()
    const graceDays = Number(c.env.GC_PURGE_GRACE_DAYS)
    const repos = await Promise.all(
      rows.map(async (r) => {
        const index = c.env.INDEX.get(
          c.env.INDEX.idFromName(r.storagePrefix.slice(0, -1)),
        )
        const usage = await index.usage()
        return {
          ...r,
          usage,
          willPurgeAt: r.deletedAt ? isoAddDays(r.deletedAt, graceDays) : null,
        }
      }),
    )
    return c.json({ repos })
  })

export default app
