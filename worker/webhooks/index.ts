import { Hono } from 'hono';

import type { AppEnv } from '@/_env';
import { decodeAction } from '@/alerts/message';
import { Alerts, isDecision } from '@/db/alerts';
import { isConfirmKind } from '@/db/alerts-schema';
import { githubVerify } from '@/middleware/githubVerify';
import { slackVerify } from '@/middleware/slackVerify';
import { handleInstallation, handleInstallationRepositories } from '@/webhooks/installation';
import { handleRepository } from '@/webhooks/repository';

// Routes mount outside `auth` — the request signature is the only gate.
const app = new Hono<AppEnv>();

// Slack interactivity: Confirm/Cancel buttons on confirmation alerts. The button `action_id`
// is the decision verb (`approve`/`cancel`) — no remapping, just validate the untrusted value.
app.post('/slack/interactions', slackVerify, async (c) => {
  const raw = new URLSearchParams(await c.req.text()).get('payload');
  if (!raw) return c.text('missing payload', 400);
  const payload = JSON.parse(raw);

  const action = payload.actions?.[0];
  const decision = action?.action_id;
  const decoded = action?.value ? decodeAction(action.value) : null;
  // Unknown action / non-confirmation kind → ack (stop retries), do nothing.
  if (!isDecision(decision) || !decoded || !isConfirmKind(decoded.kind)) return c.body(null, 200);

  const by = `slack:${payload.user?.username ?? payload.user?.id ?? 'unknown'}`;
  await Alerts.global(c.env).decide(decoded.scope, decoded.kind, decision, by);

  return c.body(null, 200);
});

// GitHub webhooks.
app.post('/github', githubVerify, async (c) => {
  const event = c.req.header('X-GitHub-Event');
  const payload = JSON.parse(await c.req.text());

  switch (event) {
    case 'repository':
      await handleRepository(c.env, payload);
      break;
    case 'installation_repositories':
      await handleInstallationRepositories(c.env, payload);
      break;
    case 'installation':
      await handleInstallation(c.env, payload);
      break;
  }

  return c.body(null, 204);
});

export default app;
