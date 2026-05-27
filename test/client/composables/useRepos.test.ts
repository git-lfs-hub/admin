import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, toRaw } from 'vue'
import type { RepoRow } from '@/types'

const mockRepos: RepoRow[] = [
  {
    owner: 'org',
    repo: 'test-repo',
    status: 'active',
    firstSeen: '2026-01-01T00:00:00Z',
    updatedAt: '2026-05-01T00:00:00Z',
    missingAt: null,
    deletedAt: null,
    earliestPurge: null,
    objectCount: 10,
    totalSize: 1024,
  },
]

const fetchMock = vi.fn()

describe('useRepos', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('fetches repos on mount', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ repos: mockRepos }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const { useRepos } = await import('@/composables/useRepos')
    const Wrapper = defineComponent({
      setup() {
        return useRepos()
      },
      render() { return null },
    })

    const wrapper = mount(Wrapper)
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledWith('/api/repos', expect.objectContaining({ credentials: 'same-origin' }))
    expect(toRaw(wrapper.vm.repos)).toEqual(mockRepos)
    expect(wrapper.vm.loading).toBe(false)
    expect(wrapper.vm.error).toBeNull()
    wrapper.unmount()
  })

  it('sets error on fetch failure', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: () => Promise.resolve({ error: 'db down' }),
    })
    vi.stubGlobal('fetch', fetchMock)

    vi.resetModules()
    const { useRepos } = await import('@/composables/useRepos')
    const Wrapper = defineComponent({
      setup() {
        return useRepos()
      },
      render() { return null },
    })

    const wrapper = mount(Wrapper)
    await flushPromises()

    expect(wrapper.vm.error).toBeInstanceOf(Error)
    expect(wrapper.vm.error!.message).toBe('db down')
    expect(wrapper.vm.loading).toBe(false)
    wrapper.unmount()
  })
})
