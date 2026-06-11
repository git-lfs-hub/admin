import { Hono } from 'hono';

import type { AppEnv } from '@/_env';
import { Alerts } from '@/db/alerts';

// Every alert row, newest first. Presentation splits them — `system:*` rows are global health
// (e.g. `system:slack` delivery), resource rows (`storage:…`) are the actionable list — but that's
// the view's call, so the API stays a flat feed.
const app = new Hono<AppEnv>().get('/', async (c) => {
  // Spread to a fresh array: `listAlerts()` is a DO RPC call whose array return carries an
  // RPC-serialized type; sorting it in place would propagate that into the response type (and
  // mutate the RPC result). `[...]` severs it to a clean `AlertRow[]`.
  const alerts = [...(await Alerts.global(c.env).listAlerts())].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );
  return c.json({ alerts });
});

export default app;
