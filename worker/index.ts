import { Hono } from 'hono'
import auth from './middleware/auth'
import me from './routes/api/me'
import loginOauth from './routes/login/oauth'

const app = new Hono<{ Bindings: CloudflareBindings; Variables: { admin: string } }>()

app.route('/login/oauth', loginOauth)

app.use('/api/*', auth)
app.route('/api/me', me)

export default app
