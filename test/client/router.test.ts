import { mount, flushPromises } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { createRouter, createMemoryHistory } from 'vue-router'
import { defineComponent } from 'vue'
import { RouterView } from 'vue-router'

describe('router', () => {
  it('redirects / to /repos', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({ repos: [] }),
    }))

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', redirect: '/repos' },
        {
          path: '/repos',
          component: defineComponent({ template: '<p>repos-page</p>' }),
        },
      ],
    })

    const App = defineComponent({
      template: '<RouterView />',
      components: { RouterView },
    })

    router.push('/')
    await router.isReady()

    const wrapper = mount(App, {
      global: { plugins: [router] },
    })
    await flushPromises()

    expect(router.currentRoute.value.path).toBe('/repos')
    expect(wrapper.text()).toContain('repos-page')
    wrapper.unmount()
  })
})
