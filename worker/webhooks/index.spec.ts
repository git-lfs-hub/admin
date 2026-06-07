import { test, expect, vi, beforeEach, describe } from 'vitest'

const handleRepository = vi.fn(async (..._a: unknown[]) => {})
const handleInstallation = vi.fn(async (..._a: unknown[]) => {})
const handleInstallationRepositories = vi.fn(async (..._a: unknown[]) => {})

vi.mock('@/webhooks/repository', () => ({
  handleRepository: (...a: unknown[]) => handleRepository(...a),
}))
vi.mock('@/webhooks/installation', () => ({
  handleInstallation: (...a: unknown[]) => handleInstallation(...a),
  handleInstallationRepositories: (...a: unknown[]) =>
    handleInstallationRepositories(...a),
}))

import app from '@/webhooks/index'

const SECRET = 'webhook-secret'
const env = { GITHUB_WEBHOOK_SECRET: SECRET } as any

async function sign(body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))
  const hex = [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  return `sha256=${hex}`
}

function post(headers: Record<string, string>, body: string) {
  return app.request('/github', { method: 'POST', headers, body }, env)
}

beforeEach(() => {
  handleRepository.mockClear()
  handleInstallation.mockClear()
  handleInstallationRepositories.mockClear()
})

describe('signature verification', () => {
  test('valid signature dispatches to the handler', async () => {
    const body = JSON.stringify({ action: 'deleted', repository: {} })
    const res = await post(
      { 'X-GitHub-Event': 'repository', 'X-Hub-Signature-256': await sign(body) },
      body,
    )
    expect(res.status).toBe(204)
    expect(handleRepository).toHaveBeenCalledOnce()
  })

  test('mismatched signature → 401, no handler', async () => {
    const body = JSON.stringify({ action: 'deleted', repository: {} })
    const res = await post(
      {
        'X-GitHub-Event': 'repository',
        'X-Hub-Signature-256': await sign('tampered'),
      },
      body,
    )
    expect(res.status).toBe(401)
    expect(handleRepository).not.toHaveBeenCalled()
  })

  test('missing signature → 401, no handler', async () => {
    const body = JSON.stringify({ action: 'deleted', repository: {} })
    const res = await post({ 'X-GitHub-Event': 'repository' }, body)
    expect(res.status).toBe(401)
    expect(handleRepository).not.toHaveBeenCalled()
  })

  test('malformed signature header → 401, no handler', async () => {
    const body = '{}'
    const res = await post(
      { 'X-GitHub-Event': 'repository', 'X-Hub-Signature-256': 'sha256=zzz' },
      body,
    )
    expect(res.status).toBe(401)
    expect(handleRepository).not.toHaveBeenCalled()
  })
})

describe('event dispatch', () => {
  test('installation_repositories → its handler', async () => {
    const body = JSON.stringify({ action: 'added' })
    const res = await post(
      {
        'X-GitHub-Event': 'installation_repositories',
        'X-Hub-Signature-256': await sign(body),
      },
      body,
    )
    expect(res.status).toBe(204)
    expect(handleInstallationRepositories).toHaveBeenCalledOnce()
    expect(handleRepository).not.toHaveBeenCalled()
  })

  test('installation → its handler', async () => {
    const body = JSON.stringify({ action: 'deleted' })
    const res = await post(
      { 'X-GitHub-Event': 'installation', 'X-Hub-Signature-256': await sign(body) },
      body,
    )
    expect(res.status).toBe(204)
    expect(handleInstallation).toHaveBeenCalledOnce()
  })

  test('unknown event passes signature but dispatches nothing', async () => {
    const body = JSON.stringify({ action: 'whatever' })
    const res = await post(
      { 'X-GitHub-Event': 'ping', 'X-Hub-Signature-256': await sign(body) },
      body,
    )
    expect(res.status).toBe(204)
    expect(handleRepository).not.toHaveBeenCalled()
    expect(handleInstallation).not.toHaveBeenCalled()
    expect(handleInstallationRepositories).not.toHaveBeenCalled()
  })
})
