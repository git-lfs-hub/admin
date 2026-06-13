import { Hono } from 'hono';

import type { AppEnv } from '@/_env';
import { gcConfig } from '@/gc/config';

// `coldStorage` is a capability flag, not the bucket name — the client only needs whether the
// cold-storage backup surface (BackUp / Clear / Delete Backup) is configured.
const app = new Hono<AppEnv>().get('/', (c) =>
  c.json({
    admin: c.var.admin,
    orgs: c.var.adminOrgs,
    coldStorage: !!gcConfig(c.env).coldStorage,
  }),
);

export default app;
