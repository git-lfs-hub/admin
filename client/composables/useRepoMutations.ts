import { useMutation, useQueryClient } from '@tanstack/vue-query';
import { toast } from 'vue-sonner';

import { api } from '@/api';

type RepoRef = { owner: string; repo: string };

// Errors surface as toasts via the shared `authFetch`, which rejects non-2xx with the
// server's `error` message.
export function useRepoMutations() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ['repos'] });

  const archive = useMutation({
    mutationFn: ({ owner, repo }: RepoRef) =>
      api.api.repos[':owner'][':repo'].archive.$post({ param: { owner, repo } }),
    onSuccess: (_res, { owner, repo }) => {
      toast.success(`Archived ${owner}/${repo}`);
      return invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const restore = useMutation({
    mutationFn: ({ owner, repo }: RepoRef) =>
      api.api.repos[':owner'][':repo'].restore.$post({ param: { owner, repo } }),
    onSuccess: (_res, { owner, repo }) => {
      toast.success(`Restored ${owner}/${repo}`);
      return invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return { archive, restore };
}
