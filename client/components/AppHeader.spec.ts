import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRouter, createMemoryHistory } from 'vue-router'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'
import AppHeader from '@/components/AppHeader.vue'

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/repos', component: { template: '<div />' } }],
  })
}

const fetchMock = vi.fn()

describe('AppHeader', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shows lfs-admin branding', () => {
    vi.stubGlobal('fetch', fetchMock.mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({ admin: 'dev' }),
    }))

    const wrapper = mount(AppHeader, {
      global: { plugins: [makeRouter(), [VueQueryPlugin, { queryClient: makeQueryClient() }]] },
    })
    expect(wrapper.text()).toContain('lfs-admin')
  })

  it('shows Repos nav link', () => {
    vi.stubGlobal('fetch', fetchMock.mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({ admin: 'dev' }),
    }))

    const wrapper = mount(AppHeader, {
      global: { plugins: [makeRouter(), [VueQueryPlugin, { queryClient: makeQueryClient() }]] },
    })
    expect(wrapper.text()).toContain('Repos')
  })

  it('shows admin username after /api/me resolves', async () => {
    vi.stubGlobal('fetch', fetchMock.mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({ admin: 'dev' }),
    }))

    const wrapper = mount(AppHeader, {
      global: { plugins: [makeRouter(), [VueQueryPlugin, { queryClient: makeQueryClient() }]] },
    })
    await flushPromises()

    expect(wrapper.text()).toContain('dev')
  })
})
