import { Hono } from 'hono';

import type { AppEnv } from '@/_env';
import { Alerts } from '@/db/alerts';

// Flat feed, newest first. The view splits `system:*` (global health) from `storage:…` (actionable).
const app = new Hono<AppEnv>().get('/', async (c) => {
  // Spread severs the RPC-serialized array type to a clean `AlertRow[]` and avoids mutating the
  // RPC result in place.
  const alerts = [...(await Alerts.global(c.env).listAlerts())].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );
  return c.json({ alerts });
});

export default app;
