import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { createRouter, createMemoryHistory } from 'vue-router';

import RepoTable from '@/components/RepoTable.vue';
import type { RepoRow } from '@/composables/useRepos';

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/repos', component: { template: '<div />' } },
      { path: '/storage', component: { template: '<div />' } },
    ],
  });
}

async function mountTable(repos: RepoRow[]) {
  const router = makeRouter();
  router.push('/repos');
  await router.isReady();
  return mount(RepoTable, {
    props: { repos },
    global: { plugins: [router] },
  });
}

const repo: RepoRow = {
  owner: 'org',
  repo: 'my-repo',
  name: 'org/my-repo',
  status: 'active',
  firstSeen: '2026-01-15T00:00:00Z',
  updatedAt: '2026-05-24T12:00:00Z',
  missingAt: null,
  storage: { prefix: 'org/my-repo', status: 'used', archivedAt: null },
};

const openHoverCard = async (trigger: ReturnType<ReturnType<typeof mount>['find']>) => {
  vi.useFakeTimers();
  await trigger.trigger('focus');
  vi.advanceTimersByTime(1000);
  vi.useRealTimers();
  await flushPromises();
};

describe('RepoTable', () => {
  it('renders repo rows with git status', async () => {
    const wrapper = await mountTable([repo]);
    expect(wrapper.text()).toContain('org/my-repo');
    expect(wrapper.text()).toContain('active');
  });

  it('links to the matching storage, hiding the redundant "used" badge', async () => {
    const wrapper = await mountTable([repo]);
    const link = wrapper.find('a[href="/storage"]');
    expect(link.exists()).toBe(true);
    expect(link.text()).toContain('org/my-repo');
    expect(wrapper.find('[data-slot="storage"]').text()).not.toContain('used');
  });

  it('badges purged storage but not the now-redundant unused state', async () => {
    const purged = await mountTable([{ ...repo, storage: { ...repo.storage!, status: 'purged' } }]);
    expect(purged.find('[data-slot="storage"]').text()).toContain('purged');

    // `unused` is implied by the repo being missing — no badge.
    const unused = await mountTable([{ ...repo, storage: { ...repo.storage!, status: 'unused' } }]);
    expect(unused.find('[data-slot="storage"]').text()).not.toContain('unused');
  });

  it('badges archived storage', async () => {
    const wrapper = await mountTable([
      { ...repo, storage: { ...repo.storage!, archivedAt: '2026-05-25T00:00:00Z' } },
    ]);
    expect(wrapper.find('[data-slot="storage"]').text()).toContain('archived');
  });

  it('renders a dash when no storage prefix matches', async () => {
    const wrapper = await mountTable([{ ...repo, storage: null }]);
    expect(wrapper.find('a[href="/storage"]').exists()).toBe(false);
    expect(wrapper.find('[data-slot="storage"]').text()).toBe('—');
  });

  it('merges status with "missing since" age, full timestamp + meaning on hover', async () => {
    const missing = {
      ...repo,
      status: 'missing' as const,
      missingAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    };
    const wrapper = await mountTable([missing]);
    const status = wrapper.find('[data-slot="status"]');
    expect(status.text()).toContain('missing');
    expect(status.text()).toContain('since 5 m ago');
    await openHoverCard(status.find('[data-slot="hover-card-trigger"]'));
    expect(document.body.textContent).toContain(new Date(missing.missingAt).toLocaleString());
    expect(document.body.textContent).toContain('No longer found on GitHub');
    wrapper.unmount();
  });

  it('shows the active status without a "since" age', async () => {
    const wrapper = await mountTable([repo]);
    const status = wrapper.find('[data-slot="status"]');
    expect(status.text()).toContain('active');
    expect(status.text()).not.toContain('since');
  });
});
