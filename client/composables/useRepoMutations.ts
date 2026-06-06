import { useMutation, useQueryClient } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import { api } from '@/api'

type RepoRef = { owner: string; repo: string }

/**
 * Lifecycle mutations for a repo. Each invalidates the `['repos']` query on success
 * so the table reflects the new status, and surfaces failures as a toast (the shared
 * `authFetch` rejects non-2xx with the server's `error` message).
 */
export function useRepoMutations() {
  const qc = useQueryClient()
  const invalidate = () => qc.invalidateQueries({ queryKey: ['repos'] })

  const archive = useMutation({
    mutationFn: ({ owner, repo }: RepoRef) =>
      api.api.repos[':owner'][':repo'].archive.$post({ param: { owner, repo } }),
    onSuccess: (_res, { owner, repo }) => {
      toast.success(`Archived ${owner}/${repo}`)
      return invalidate()
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const restore = useMutation({
    mutationFn: ({ owner, repo }: RepoRef) =>
      api.api.repos[':owner'][':repo'].restore.$post({ param: { owner, repo } }),
    onSuccess: (_res, { owner, repo }) => {
      toast.success(`Restored ${owner}/${repo}`)
      return invalidate()
    },
    onError: (e: Error) => toast.error(e.message),
  })

  return { archive, restore }
}
