import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import type { InferResponseType } from 'hono/client';
import { toast } from 'vue-sonner';

import { api } from '@/api';

const branchesApi = api.api.repos[':owner'][':repo'].branches;

// The owner-admin guard adds a 403 `{ error }` arm; keep only the success shape.
type BranchesOk = Extract<InferResponseType<typeof branchesApi.$get>, { branches: unknown }>;

// One branch of a git repo: its `.lfsconfig` prefix + lifecycle, with prefix-level usage.
export type Branch = BranchesOk['branches'][number];

export function useBranches(owner: string, repo: string) {
  return useQuery({
    queryKey: ['branches', owner, repo],
    queryFn: async () => (await branchesApi.$get({ param: { owner, repo } })).json(),
    select: (d) => ('branches' in d ? d.branches : []),
  });
}

// Confirm forfeits a branch's references (storage recomputes blocks); undelete reverses it. Both
// shift the branch list, the storage rows (block set), and alerts.
export function useBranchMutations(owner: string, repo: string) {
  const qc = useQueryClient();
  const invalidate = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['branches', owner, repo] }),
      qc.invalidateQueries({ queryKey: ['storage'] }),
      qc.invalidateQueries({ queryKey: ['alerts'] }),
    ]);

  const remove = useMutation({
    mutationFn: (branch: string) =>
      branchesApi[':branch'].delete.$post({ param: { owner, repo, branch } }),
    onSuccess: (_res, branch) => {
      toast.success(`Deleted branch ${branch}`);
      return invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const undelete = useMutation({
    mutationFn: (branch: string) =>
      branchesApi[':branch'].undelete.$post({ param: { owner, repo, branch } }),
    onSuccess: (_res, branch) => {
      toast.success(`Undeleted branch ${branch}`);
      return invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return { remove, undelete };
}
