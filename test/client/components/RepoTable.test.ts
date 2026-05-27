import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import RepoTable from '@/components/RepoTable.vue'
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
})
