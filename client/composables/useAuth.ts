import { useQuery } from '@tanstack/vue-query'
import { api } from '@/api'

export function useAuth() {
  const query = useQuery({
    queryKey: ['me'],
    queryFn: async () => (await api.api.me.$get()).json(),
    select: (d) => d.admin,
    staleTime: Infinity,
  })
  return { admin: query.data }
}
