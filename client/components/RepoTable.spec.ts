import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import RepoTable from '@/components/RepoTable.vue'
import type { RepoRow } from '@/composables/useRepos'

const repo: RepoRow = {
  owner: 'org',
  repo: 'my-repo',
  status: 'active',
  firstSeen: '2026-01-15T00:00:00Z',
  updatedAt: '2026-05-24T12:00:00Z',
  missingAt: null,
  deletedAt: null,
  purgedAt: null,
  willPurgeAt: null,
  objectCount: 142,
  totalSize: 1073741824,
}

describe('RepoTable', () => {
  it('renders repo rows', () => {
    const wrapper = mount(RepoTable, { props: { repos: [repo] } })
    expect(wrapper.text()).toContain('org/my-repo')
    expect(wrapper.text()).toContain('active')
  })

  it('renders size and object count', () => {
    const wrapper = mount(RepoTable, { props: { repos: [repo] } })
    expect(wrapper.text()).toContain('142')
    expect(wrapper.text()).toContain('1.07 GB')
  })

  it('renders dash for null size', () => {
    const nullSizeRepo = { ...repo, totalSize: null, objectCount: null }
    const wrapper = mount(RepoTable, { props: { repos: [nullSizeRepo] } })
    expect(wrapper.text()).toContain('—')
  })

  it('renders willPurgeAt when set', () => {
    const purging = { ...repo, status: 'deleted' as const, deletedAt: '2026-05-20T00:00:00Z', willPurgeAt: '2026-05-27T00:00:00Z' }
    const wrapper = mount(RepoTable, { props: { repos: [purging] } })
    expect(wrapper.text()).toContain(new Date('2026-05-27T00:00:00Z').toLocaleString())
  })

  it('renders dash for null willPurgeAt', () => {
    const wrapper = mount(RepoTable, { props: { repos: [repo] } })
    const cells = wrapper.findAll('td')
    expect(cells.some((c) => c.text() === '—')).toBe(true)
  })
})
