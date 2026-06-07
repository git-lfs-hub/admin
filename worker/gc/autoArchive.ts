import type { Repos, RepoRow } from '@/db/repos';
import { isoAddDays } from '@/lib/time';
import { lfsServer } from '@/server/lfs-server';

/** Cron: block `missing` repos past their grace window (`missingAt + autoArchiveDays`).
 *  Status untouched. RPC before the DB write, so a failure retries next tick. */
export async function autoArchive(
  env: CloudflareBindings,
  repos: DurableObjectStub<Repos>,
): Promise<RepoRow[]> {
  const server = lfsServer(env);
  const now = Date.now();
  const archived: RepoRow[] = [];
  for (const r of await repos.listByStatus('missing')) {
    if (r.archivedAt || !r.missingAt) continue;
    if (Date.parse(isoAddDays(r.missingAt, env.GC.autoArchiveDays)) > now) continue;
    try {
      await server.blockRepo(r.owner, r.repo);
      const row = await repos.block(r.owner, r.repo);
      if (row) archived.push(row);
    } catch (e) {
      console.error(`[auto-archive] failed for ${r.name}:`, e);
    }
  }
  return archived;
}
