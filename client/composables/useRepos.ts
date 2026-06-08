import { useQuery } from '@tanstack/vue-query';
import type { InferResponseType } from 'hono/client';

import { api } from '@/api';

export type RepoRow = InferResponseType<typeof api.api.repos.$get>['repos'][number];
// The list now surfaces `storage` rows (prefix lifecycle); their status drives the badge.
// Full two-view "Repositories + Storage" UI language is C1.5.
export { type StorageStatus as RepoStatus } from '@worker/db/registry-schema';

export function useRepos() {
  return useQuery({
    queryKey: ['repos'],
    queryFn: async () => (await api.api.repos.$get()).json(),
    select: (d) => d.repos,
  });
}
