import { Hono } from 'hono';

import type { AppEnv } from '@/_env';
import { decodeAction, isNotifyAction, scopeLabel, type NotifyAction } from '@/alerts/message';
import { Alerts, isDecision } from '@/db/alerts';
import { isConfirmKind } from '@/db/alerts-schema';
import { Registry } from '@/db/registry';
import { githubVerify } from '@/middleware/githubVerify';
import { slackVerify } from '@/middleware/slackVerify';
import { archive, restore } from '@/server/operations';
import { handleInstallation, handleInstallationRepositories } from '@/webhooks/installation';
import { handlePush } from '@/webhooks/push';
import { handleRepository } from '@/webhooks/repository';
import { wakeConfirmation } from '@/workflows/confirm';

// Routes mount outside `auth` — the request signature is the only gate.
const app = new Hono<AppEnv>();

// Slack interactivity. The button `action_id` is the verb — no remapping, just validate the
// untrusted value: `approve`/`cancel` decisions on confirmation alerts, `archive`/`restore`
// default actions on notify alerts.
app.post('/slack/interactions', slackVerify, async (c) => {
  const raw = new URLSearchParams(await c.req.text()).get('payload');
  if (!raw) return c.text('missing payload', 400);
  const payload = JSON.parse(raw);

  const action = payload.actions?.[0];
  const verb = action?.action_id;
  const decoded = action?.value ? decodeAction(action.value) : null;
  if (!decoded) return c.body(null, 200);
  const by = `slack:${payload.user?.username ?? payload.user?.id ?? 'unknown'}`;

  // Confirmation decision → record + wake the waiting workflow only when it actually changed
  // (idempotent re-clicks already woke it). The wake dispatches per kind (purge / clear).
  if (isDecision(verb) && isConfirmKind(decoded.kind)) {
    const res = await Alerts.global(c.env).decide(decoded.scope, decoded.kind, verb, by);
    if (res.ok) await wakeConfirmation(c.env, decoded.scope, decoded.kind, verb, by);
    return c.body(null, 200);
  }

  // Notify-alert default action (missing → archive, archived → restore).
  if (isNotifyAction(verb)) await runNotifyAction(c.env, verb, decoded.scope);

  // Unknown action / state mismatch → ack (stop retries), do nothing.
  return c.body(null, 200);
});

// Run a notify alert's default action against its storage prefix. Guards mirror the storage
// routes so a stale button can't block a now-live prefix or restore a purged one. Best-effort:
// a refused/failed op leaves the message as-is; on success the lifecycle `notify` chat.updates
// the message in place to the new state (and its new default action).
async function runNotifyAction(
  env: CloudflareBindings,
  verb: NotifyAction,
  scope: string,
): Promise<void> {
  const [owner, repo] = scopeLabel(scope).split('/');
  if (!owner || !repo) return;
  const registry = Registry.global(env);
  const row = await registry.getStorageByPrefix(`${owner}/${repo}`);
  if (!row) return;
  try {
    if (verb === 'archive') {
      if (row.status !== 'unused' || row.archivedAt) return;
      await archive(env, registry, row.prefix);
    } else {
      if (!row.archivedAt || row.status === 'purged' || row.activeOp === 'purge') return;
      await restore(env, registry, row.prefix);
    }
  } catch (e) {
    console.error(`[slack] ${verb} ${scope} failed:`, e);
  }
}

// GitHub webhooks.
app.post('/github', githubVerify, async (c) => {
  const event = c.req.header('X-GitHub-Event');
  const payload = JSON.parse(await c.req.text());

  switch (event) {
    case 'push':
      await handlePush(c.env, payload);
      break;
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
