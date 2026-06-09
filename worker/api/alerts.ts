import { Hono } from 'hono';

import type { AppEnv } from '@/_env';
import { Alerts, type AlertRow } from '@/db/alerts';
import { SYSTEM_SLACK_SCOPE } from '@/db/alerts-schema';

const app = new Hono<AppEnv>().get('/', async (c) => {
  const rows = await Alerts.global(c.env).listAlerts();

  const alerts = rows
    .filter((r) => !r.scope.startsWith('system:'))
    .sort((a: AlertRow, b: AlertRow) => b.updatedAt.localeCompare(a.updatedAt));

  const sys = rows.find((r) => r.scope === SYSTEM_SLACK_SCOPE);
  const slackError = sys?.detail ? { message: sys.detail, at: sys.updatedAt } : null;

  return c.json({ alerts, slackError });
});

export default app;
