import { Hono } from "hono";
import { isoAddDays } from "@/lib/time";
import type { AppEnv } from "@/_env";

const app = new Hono<AppEnv>().get("/", async (c) => {
  const repos = c.env.REPOS.getByName("global");
  const rows = await repos.listAll();
  const graceDays = Number(c.env.GC_PURGE_GRACE_DAYS);
  const result = await Promise.all(
    rows.map(async (row) => {
      const repo = c.env.REPO.getByName(row.name);
      const [usage, lastAccessedAt] = await Promise.all([repo.usage(), repo.lastAccessedAt()]);
      return {
        ...row,
        usage,
        lastAccessedAt,
        willPurgeAt: row.deletedAt ? isoAddDays(row.deletedAt, graceDays) : null,
      };
    }),
  );
  return c.json({ repos: result });
});

export default app;
