import { useQuery } from '@tanstack/vue-query';
import type { InferResponseType } from 'hono/client';

import { api } from '@/api';

// GitHub presence (git identity), cross-linked to its storage prefix by same-key lookup.
export type RepoRow = InferResponseType<typeof api.api.repos.$get>['repos'][number];
export { type RepoStatus } from '@worker/db/registry-schema';

export function useRepos() {
  return useQuery({
    queryKey: ['repos'],
    queryFn: async () => (await api.api.repos.$get()).json(),
    select: (d) => [...d.repos].sort(byActionable),
  });
}

// Problems first, irrelevant last: a `missing` repo still backed by storage needs attention (that
// storage is now unused); then `active` repos serving storage. Repos with no inferred storage are
// noise — nothing to act on, missing or not — so they sink to the bottom. Ties break on owner/repo.
function byActionable(a: RepoRow, b: RepoRow) {
  return rank(a) - rank(b) || `${a.owner}/${a.repo}`.localeCompare(`${b.owner}/${b.repo}`);
}

function rank(r: RepoRow) {
  if (!r.storage) return 2;
  return r.status === 'missing' ? 0 : 1;
}
