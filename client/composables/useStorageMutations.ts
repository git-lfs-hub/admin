import { useMutation, useQueryClient } from '@tanstack/vue-query';
import { toast } from 'vue-sonner';

import { api } from '@/api';

// A prefix's two URL-path segments (the same-key handle on the storage row).
type PrefixRef = { owner: string; repo: string };

// Archive/Restore is the storage-prefix verb; under the hood it block/unblocks the repo's
// LFS serving via the lfs-server RPC. Errors surface as toasts via the shared `authFetch`,
// which rejects non-2xx with the server's `error` message.
export function useStorageMutations() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ['storage'] });

  const archive = useMutation({
    mutationFn: ({ owner, repo }: PrefixRef) =>
      api.api.storage[':owner'][':repo'].archive.$post({ param: { owner, repo } }),
    onSuccess: (_res, { owner, repo }) => {
      toast.success(`Archived ${owner}/${repo}`);
      return invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const restore = useMutation({
    mutationFn: ({ owner, repo }: PrefixRef) =>
      api.api.storage[':owner'][':repo'].restore.$post({ param: { owner, repo } }),
    onSuccess: (_res, { owner, repo }) => {
      toast.success(`Restored ${owner}/${repo}`);
      return invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return { archive, restore };
}
