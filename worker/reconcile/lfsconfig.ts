import type { RepoScan } from '@git-lfs-hub/lib/github';

import { Repo } from '@/db/repo';
import { scanLfsconfigInline } from '@/github/lfsconfig';

/** Cron backstop: the GraphQL sweep already carries each repo's `.lfsconfig`, so recording adds no
 *  GitHub calls. `syncLinks` runs only on a changed scan; per-repo failures stay isolated. */
export async function syncLfsconfigs(env: CloudflareBindings, scans: RepoScan[]): Promise<void> {
  for (const s of scans) {
    if (!s.branch || !s.headSha) continue; // empty repo — no default branch to scan
    try {
      const repo = Repo.byRepo(env, s.owner, s.name);
      const ref = { owner: s.owner, repo: s.name, branch: s.branch, headSha: s.headSha };
      const outcome = await scanLfsconfigInline(repo, env, ref, s.lfsconfig);
      if (outcome !== 'unchanged' && outcome !== 'unreachable') {
        await repo.syncLinks(s.owner, s.name);
      }
    } catch (e) {
      console.error(`[reconcile] lfsconfig sweep failed for ${s.owner}/${s.name}:`, e);
    }
  }
}
