import { Hono } from 'hono'

const app = new Hono<{ Bindings: CloudflareBindings; Variables: { admin: string } }>()

app.get('/', (c) => c.json({ admin: c.var.admin }))

export default app
