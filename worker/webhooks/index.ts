import { Hono } from 'hono'
import { verifyWebhookSignature } from '@git-lfs-hub/lib/auth'
import type { AppEnv } from '@/_env'
import { handleRepository } from '@/webhooks/repository'
import {
  handleInstallation,
  handleInstallationRepositories,
} from '@/webhooks/installation'

const app = new Hono<AppEnv>()

// Public route (mounted outside `auth`) — the HMAC is the only gate. Verify over the raw
// body BEFORE parsing, so a forged payload never reaches a handler or mutates a DO.
app.post('/github', async (c) => {
  const signature = c.req.header('X-Hub-Signature-256')
  const body = await c.req.text()

  if (!(await verifyWebhookSignature(body, signature, c.env.GITHUB_WEBHOOK_SECRET)))
    return c.text('invalid signature', 401)

  const event = c.req.header('X-GitHub-Event')
  const payload = JSON.parse(body)

  switch (event) {
    case 'repository':
      await handleRepository(c.env, payload)
      break
    case 'installation_repositories':
      await handleInstallationRepositories(c.env, payload)
      break
    case 'installation':
      await handleInstallation(c.env, payload)
      break
  }

  return c.body(null, 204)
})

export default app
