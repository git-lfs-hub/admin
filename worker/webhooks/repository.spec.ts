import { test, expect, vi, beforeEach, describe } from 'vitest'

const reconcileRepoEvent = vi.fn(async (..._a: unknown[]) => {})
vi.mock('@/reconcile/repos', () => ({
  reconcileRepoEvent: (...a: unknown[]) => reconcileRepoEvent(...a),
}))

import { handleRepository } from '@/webhooks/repository'

const reposStub = { id: 'repos' }
const env = { REPOS: { getByName: () => reposStub } } as any

function repoEvent(action: string, extra: Record<string, unknown> = {}) {
  return {
    action,
    repository: { name: 'foo', full_name: 'acme/foo', owner: { login: 'acme' } },
    ...extra,
  } as any
}

beforeEach(() => reconcileRepoEvent.mockClear())

describe('handleRepository', () => {
  test.each(['deleted', 'privatized', 'archived'])(
    '%s → present=false',
    async (action) => {
      await handleRepository(env, repoEvent(action))
      expect(reconcileRepoEvent).toHaveBeenCalledWith(env, reposStub, 'acme', 'foo', false)
    },
  )

  test.each(['created', 'publicized', 'unarchived'])(
    '%s → present=true',
    async (action) => {
      await handleRepository(env, repoEvent(action))
      expect(reconcileRepoEvent).toHaveBeenCalledWith(env, reposStub, 'acme', 'foo', true)
    },
  )

  test('unknown action → no-op', async () => {
    await handleRepository(env, repoEvent('edited'))
    expect(reconcileRepoEvent).not.toHaveBeenCalled()
  })

  test('renamed → old name (same owner) goes missing', async () => {
    await handleRepository(
      env,
      repoEvent('renamed', { changes: { repository: { name: { from: 'old' } } } }),
    )
    expect(reconcileRepoEvent).toHaveBeenCalledWith(env, reposStub, 'acme', 'old', false)
  })

  test('renamed without changes → no-op', async () => {
    await handleRepository(env, repoEvent('renamed'))
    expect(reconcileRepoEvent).not.toHaveBeenCalled()
  })

  test('transferred (from org) → old owner, same repo, missing', async () => {
    await handleRepository(
      env,
      repoEvent('transferred', {
        changes: { owner: { from: { organization: { login: 'oldorg' } } } },
      }),
    )
    expect(reconcileRepoEvent).toHaveBeenCalledWith(env, reposStub, 'oldorg', 'foo', false)
  })

  test('transferred (from user) → old user owner', async () => {
    await handleRepository(
      env,
      repoEvent('transferred', {
        changes: { owner: { from: { user: { login: 'olduser' } } } },
      }),
    )
    expect(reconcileRepoEvent).toHaveBeenCalledWith(env, reposStub, 'olduser', 'foo', false)
  })

  test('transferred without changes → no-op', async () => {
    await handleRepository(env, repoEvent('transferred'))
    expect(reconcileRepoEvent).not.toHaveBeenCalled()
  })
})
