import { useQuery } from '@tanstack/vue-query';
import { lifecycleState } from '@worker/storage/actions';
import type { InferResponseType } from 'hono/client';

import { api } from '@/api';

// Storage prefix lifecycle, cross-linked to its git repo by same-key lookup.
export type StorageRow = InferResponseType<typeof api.api.storage.$get>['storage'][number];
export { type StorageStatus } from '@worker/db/registry-schema';

export function useStorage() {
  return useQuery({
    queryKey: ['storage'],
    queryFn: async () => (await api.api.storage.$get()).json(),
    select: (d) => [...d.storage].sort(byActionable),
    // Live-refresh while any prefix has an in-flight op (e.g. a pending Purge countdown).
    refetchInterval: (query) => (query.state.data?.storage.some((r) => r.activeOp) ? 4000 : false),
  });
}

// Actionable first, obsolete last: a pending purge needs a confirm/cancel decision, then unused
// (repo missing) and archived (serving blocked); `used` is the resting norm and `purged` is dead.
// Ties break on prefix for a stable order.
function byActionable(a: StorageRow, b: StorageRow) {
  return rank(a) - rank(b) || a.prefix.localeCompare(b.prefix);
}

function rank(r: StorageRow) {
  if (r.activeOp === 'purge') return 0;
  return { unused: 1, archived: 2, used: 3, purged: 4, purging: 0 }[lifecycleState(r)];
}
