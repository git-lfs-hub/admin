import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'
import RepoTable from '@/components/RepoTable.vue'
import type { RepoRow } from '@/composables/useRepos'

function mountTable(repos: RepoRow[]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return mount(RepoTable, {
    props: { repos },
    global: { plugins: [[VueQueryPlugin, { queryClient }]] },
  })
}

const zeroUsage = {
  deleted: { count: 0, size: 0 },
  missing: { count: 0, size: 0 },
  pending: { count: 0, size: 0 },
  present: { count: 0, size: 0 },
  purged: { count: 0, size: 0 },
}

const repo: RepoRow = {
  owner: 'org',
  repo: 'my-repo',
  status: 'active',
  name: 'org/my-repo',
  firstSeen: '2026-01-15T00:00:00Z',
  updatedAt: '2026-05-24T12:00:00Z',
  missingAt: null,
  archivedAt: null,
  backedUpAt: null,
  backupComplete: false,
  clearedAt: null,
  purgedAt: null,
  activeOp: null,
  willArchiveAt: null,
  willPurgeAt: null,
  lastAccessedAt: '2026-05-24T12:00:00Z',
  usage: { ...zeroUsage, present: { count: 142, size: 1073741824 } },
}

describe('RepoTable', () => {
  it('renders repo rows', () => {
    const wrapper = mountTable([repo])
    expect(wrapper.text()).toContain('org/my-repo')
    expect(wrapper.text()).toContain('active')
  })

  it('renders size and object count', () => {
    const wrapper = mountTable([repo])
    expect(wrapper.text()).toContain('142')
    expect(wrapper.text()).toContain('1.07 GB')
  })

  it('renders zero size and count for empty usage', () => {
    const emptyRepo = { ...repo, usage: zeroUsage }
    const wrapper = mountTable([emptyRepo])
    const cells = wrapper.findAll('td')
    expect(cells[2].text()).toBe('0 B')
    expect(cells[3].text()).toBe('0')
  })

  it('renders willArchiveAt as a date with full timestamp on hover', () => {
    const missing = { ...repo, status: 'missing' as const, missingAt: '2026-05-20T00:00:00Z', willArchiveAt: '2026-05-27T00:00:00Z' }
    const span = mountTable([missing]).find('td:nth-child(6) span')
    expect(span.text()).toBe(new Date('2026-05-27T00:00:00Z').toLocaleDateString())
    expect(span.attributes('title')).toBe(new Date('2026-05-27T00:00:00Z').toLocaleString())
  })

  it('renders lastAccessed relative with absolute timestamp on hover', () => {
    const recent = { ...repo, lastAccessedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString() }
    const wrapper = mountTable([recent])
    const span = wrapper.find('td:nth-child(5) span')
    expect(span.text()).toBe('5m ago')
    expect(span.attributes('title')).toBe(new Date(recent.lastAccessedAt).toLocaleString())
  })

  it('renders dash for null lastAccessedAt', () => {
    const noAccess = { ...repo, lastAccessedAt: null }
    const wrapper = mountTable([noAccess])
    expect(wrapper.find('td:nth-child(5)').text()).toBe('—')
  })

  it('renders dash for null willArchiveAt', () => {
    const wrapper = mountTable([repo])
    const cells = wrapper.findAll('td')
    expect(cells.some((c) => c.text() === '—')).toBe(true)
  })

  const actionLabels = (repos: RepoRow[]) =>
    mountTable(repos).findAll('button').map((b) => b.text())

  it('shows Archive for missing, not-yet-blocked repos only', () => {
    expect(actionLabels([{ ...repo, status: 'missing' }])).toContain('Archive')
    expect(actionLabels([repo])).not.toContain('Archive') // active
    // already blocked → Restore, not Archive
    expect(actionLabels([{ ...repo, status: 'missing', archivedAt: '2026-05-25T00:00:00Z' }])).not.toContain('Archive')
  })

  it('shows Restore whenever the repo is blocked (archivedAt set), regardless of status', () => {
    expect(actionLabels([{ ...repo, status: 'missing', archivedAt: '2026-05-25T00:00:00Z' }])).toContain('Restore')
    expect(actionLabels([{ ...repo, status: 'missing' }])).not.toContain('Restore')
    expect(actionLabels([repo])).not.toContain('Restore') // active, unblocked
  })

  it('renders an Archived badge when blocked', () => {
    expect(mountTable([{ ...repo, status: 'missing', archivedAt: '2026-05-25T00:00:00Z' }]).text()).toContain('archived')
    expect(mountTable([repo]).text()).not.toContain('archived')
  })
})
