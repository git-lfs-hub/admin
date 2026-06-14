import { useQuery } from '@tanstack/vue-query';
import { computed } from 'vue';

import { api } from '@/api';

// Whether a cold-storage backup backend is configured (`env.GC.coldStorage`). Gates the BackUp /
// Clear / Delete Backup surface in StorageTable. Shares the `['me']` query with useAuth.
export function useColdStorage() {
  const query = useQuery({
    queryKey: ['me'],
    queryFn: async () => (await api.api.me.$get()).json(),
    staleTime: Infinity,
  });
  return computed(() => query.data.value?.coldStorage ?? false);
}
