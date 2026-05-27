import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRouter, createMemoryHistory } from 'vue-router'
import ReposPage from '@/pages/ReposPage.vue'
import type { RepoRow } from '@/types'

const repo: RepoRow = {
  owner: 'org',
  repo: 'my-repo',
  status: 'active',
  firstSeen: '2026-01-15T00:00:00Z',
  updatedAt: '2026-05-24T12:00:00Z',
  missingAt: null,
  deletedAt: null,
  earliestPurge: null,
  objectCount: 42,
  totalSize: 2048,
}

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/repos', component: { template: '<div />' } }],
  })
}

const fetchMock = vi.fn()

describe('ReposPage', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders empty state when no repos', async () => {
    vi.stubGlobal('fetch', fetchMock.mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({ repos: [] }),
    }))

    const wrapper = mount(ReposPage, {
      global: { plugins: [makeRouter()] },
    })
    await flushPromises()

    expect(wrapper.text()).toContain('No repositories discovered yet.')
  })

  it('renders error alert on fetch failure', async () => {
    vi.stubGlobal('fetch', fetchMock.mockResolvedValue({
      ok: false, status: 500, statusText: 'Internal Server Error',
      json: () => Promise.resolve({ error: 'db down' }),
    }))

    const wrapper = mount(ReposPage, {
      global: { plugins: [makeRouter()] },
    })
    await flushPromises()

    expect(wrapper.text()).toContain('Failed to load')
    expect(wrapper.text()).toContain('db down')
  })

  it('renders loading skeletons initially', () => {
    vi.stubGlobal('fetch', fetchMock.mockReturnValue(new Promise(() => {})))

    const wrapper = mount(ReposPage, {
      global: { plugins: [makeRouter()] },
    })

    expect(wrapper.text()).toContain('Repositories')
    expect(wrapper.findAll('[class*="skeleton"], [data-slot="skeleton"]').length).toBeGreaterThan(0)
  })

  it('renders repo table when repos exist', async () => {
    vi.stubGlobal('fetch', fetchMock.mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({ repos: [repo] }),
    }))

    const wrapper = mount(ReposPage, {
      global: { plugins: [makeRouter()] },
    })
    await flushPromises()

    expect(wrapper.text()).toContain('org/my-repo')
    expect(wrapper.text()).toContain('active')
  })

  it('has Repositories heading', async () => {
    vi.stubGlobal('fetch', fetchMock.mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({ repos: [] }),
    }))

    const wrapper = mount(ReposPage, {
      global: { plugins: [makeRouter()] },
    })
    await flushPromises()

    expect(wrapper.find('h2').text()).toBe('Repositories')
  })
})
