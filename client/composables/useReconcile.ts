import { useMutation, useQueryClient } from '@tanstack/vue-query';
import { toast } from 'vue-sonner';

import { api } from '@/api';

// Kick the discovery + reconcile pass on demand (vs waiting for the hourly cron). The pass runs
// in the background server-side, so refetch the lists a few seconds later to pick up new rows.
export function useReconcile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.api.reconcile.$post(),
    onSuccess: () => {
      toast.success('Reconcile started — refreshing shortly');
      setTimeout(() => {
        for (const key of ['storage', 'repos', 'alerts']) {
          qc.invalidateQueries({ queryKey: [key] });
        }
      }, 4000);
    },
    onError: (e: Error) => toast.error(e.message),
  });
}
