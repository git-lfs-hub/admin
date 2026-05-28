import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function loadApi() {
  vi.resetModules()
  return (await import('@/api')).api
}

describe('authFetch (via api client)', () => {
  it('redirects on 401', async () => {
    const assign = vi.fn()
    vi.stubGlobal('window', { location: { assign } })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        clone() {
          return this
        },
        json: () => Promise.resolve({}),
      }),
    )

    const api = await loadApi()
    await expect(api.api.me.$get()).rejects.toThrow('unauthenticated')
    expect(assign).toHaveBeenCalledWith('/login/oauth/authorize')
  })

  it('throws server error message on non-401 failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Server Error',
        clone() {
          return this
        },
        json: () => Promise.resolve({ error: 'boom' }),
      }),
    )

    const api = await loadApi()
    await expect(api.api.me.$get()).rejects.toThrow('boom')
  })

  it('falls back to status text when body has no error field', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        clone() {
          return this
        },
        json: () => Promise.resolve({}),
      }),
    )

    const api = await loadApi()
    await expect(api.api.me.$get()).rejects.toThrow('503 Service Unavailable')
  })
})
