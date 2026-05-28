import { useQuery } from '@tanstack/vue-query'
import { api } from '@/api'
import type { InferResponseType } from 'hono/client'

export type RepoRow = InferResponseType<typeof api.api.repos.$get>['repos'][number]
export { type RepoStatus } from '@worker/db/_repos-schema'

export function useRepos() {
  return useQuery({
    queryKey: ['repos'],
    queryFn: async () => (await api.api.repos.$get()).json(),
    select: (d) => d.repos,
  })
}
