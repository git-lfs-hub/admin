import { Hono } from "hono";
import { isoAddDays } from "@/lib/time";
import type { AppEnv } from "@/_env";

const app = new Hono<AppEnv>().get("/", async (c) => {
  const stub = c.env.REPOS.get(c.env.REPOS.idFromName("global"));
  const rows = await stub.listAll();
  const graceDays = Number(c.env.GC_PURGE_GRACE_DAYS);
  const repos = await Promise.all(
    rows.map(async (repo) => {
      const index = c.env.INDEX.get(c.env.INDEX.idFromName(repo.name));
      const usage = await index.usage();
      return {
        ...repo,
        usage,
        willPurgeAt: repo.deletedAt ? isoAddDays(repo.deletedAt, graceDays) : null,
      };
    }),
  );
  return c.json({ repos });
});

export default app;
