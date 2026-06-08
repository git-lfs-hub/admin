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
    select: (d) => d.repos,
  });
}
