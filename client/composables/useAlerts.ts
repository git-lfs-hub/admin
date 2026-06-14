import { useQuery } from '@tanstack/vue-query';
import type { InferResponseType } from 'hono/client';

import { api } from '@/api';

type AlertsResponse = InferResponseType<typeof api.api.alerts.$get>;
export type Alert = AlertsResponse['alerts'][number];

export function useAlerts() {
  return useQuery({
    queryKey: ['alerts'],
    queryFn: async () => (await api.api.alerts.$get()).json(),
  });
}
