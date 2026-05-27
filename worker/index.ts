import { Hono } from 'hono'
import auth from './middleware/auth'
import me from './api/me'
import loginOauth from './login/oauth'

export { Repos } from './db/repos'

const app = new Hono<{ Bindings: CloudflareBindings; Variables: { admin: string } }>()

app.route('/login/oauth', loginOauth)

app.use('/api/*', auth)
app.route('/api/me', me)

app.get('*', auth, (c) => c.env.ASSETS.fetch(c.req.raw))

export default app
