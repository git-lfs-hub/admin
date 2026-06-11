import { useQuery } from '@tanstack/vue-query';
import type { InferResponseType } from 'hono/client';

import { api } from '@/api';

// Storage prefix lifecycle, cross-linked to its git repo by same-key lookup.
export type StorageRow = InferResponseType<typeof api.api.storage.$get>['storage'][number];
export { type StorageStatus } from '@worker/db/registry-schema';

export function useStorage() {
  return useQuery({
    queryKey: ['storage'],
    queryFn: async () => (await api.api.storage.$get()).json(),
    select: (d) => d.storage,
    // Live-refresh while any prefix has an in-flight op (e.g. a pending Purge countdown).
    refetchInterval: (query) => (query.state.data?.storage.some((r) => r.activeOp) ? 4000 : false),
  });
}
