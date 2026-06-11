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

  // Purge = preview (impact + state-bound token) → POST with that token. `authFetch` rejects a
  // non-2xx preview (gate 409s), so the chain surfaces the same toast as a direct failure.
  const purge = useMutation({
    mutationFn: async ({ owner, repo }: PrefixRef) => {
      const res = await api.api.storage[':owner'][':repo'].purge.preview.$post({
        param: { owner, repo },
      });
      const prev = (await res.json()) as { token?: string };
      if (!prev.token) throw new Error('preview failed');
      // The purge route reads the token off the raw body (no validator), so send it via `init`.
      return api.api.storage[':owner'][':repo'].purge.$post(
        { param: { owner, repo } },
        {
          headers: { 'content-type': 'application/json' },
          init: { body: JSON.stringify({ token: prev.token }) },
        },
      );
    },
    onSuccess: (_res, { owner, repo }) => {
      toast.success(`Purge started for ${owner}/${repo}`);
      return invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Confirm/Cancel the in-flight Purge workflow (non-blocking quick actions, no preview).
  const confirmWorkflow = useMutation({
    mutationFn: ({ owner, repo }: PrefixRef) =>
      api.api.storage[':owner'][':repo'].workflow.confirm.$post({ param: { owner, repo } }),
    onSuccess: (_res, { owner, repo }) => {
      toast.success(`Confirmed purge for ${owner}/${repo}`);
      return invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const cancelWorkflow = useMutation({
    mutationFn: ({ owner, repo }: PrefixRef) =>
      api.api.storage[':owner'][':repo'].workflow.cancel.$post({ param: { owner, repo } }),
    onSuccess: (_res, { owner, repo }) => {
      toast.success(`Cancelled purge for ${owner}/${repo}`);
      return invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return { archive, restore, purge, confirmWorkflow, cancelWorkflow };
}
