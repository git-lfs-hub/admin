import { reconcileRepoEvent } from '@/reconcile/repos'

// `repository` webhook → shared DO path. The `action` carries precision REST org-listing
// lacks (deleted vs privatized vs transferred), but all gone/inaccessible actions collapse to
// one `missing` presence in the 3-state model.
export type RepositoryEvent = {
  action: string
  repository: {
    name: string
    full_name: string
    owner: { login: string }
  }
  changes?: {
    repository?: { name?: { from?: string } }
    owner?: {
      from?: { organization?: { login?: string }; user?: { login?: string } }
    }
  }
}

const ABSENT = new Set(['deleted', 'privatized', 'archived'])
const PRESENT = new Set(['created', 'publicized', 'unarchived'])

export async function handleRepository(
  env: CloudflareBindings,
  payload: RepositoryEvent,
) {
  const repos = env.REPOS.getByName('global')
  const { action, repository } = payload
  const owner = repository.owner.login
  const repo = repository.name

  // rename/transfer: source location goes missing; the new name is left to R2 discovery.
  if (action === 'renamed' || action === 'transferred') {
    const old = oldLocation(payload, owner, repo)
    if (old) await reconcileRepoEvent(env, repos, old.owner, old.repo, false)
    return
  }
  if (PRESENT.has(action)) {
    await reconcileRepoEvent(env, repos, owner, repo, true)
  } else if (ABSENT.has(action)) {
    await reconcileRepoEvent(env, repos, owner, repo, false)
  }
}

function oldLocation(
  payload: RepositoryEvent,
  owner: string,
  repo: string,
): { owner: string; repo: string } | null {
  if (payload.action === 'renamed') {
    const from = payload.changes?.repository?.name?.from
    return from ? { owner, repo: from } : null // rename keeps the owner
  }
  // transfer changes the owner; the repo name is unchanged
  const from =
    payload.changes?.owner?.from?.organization?.login ??
    payload.changes?.owner?.from?.user?.login
  return from ? { owner: from, repo } : null
}
