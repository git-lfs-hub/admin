import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { createRouter, createMemoryHistory } from 'vue-router';

import StorageTable from '@/components/StorageTable.vue';
import type { StorageRow } from '@/composables/useStorage';

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/repos', component: { template: '<div />' } },
      { path: '/storage', component: { template: '<div />' } },
    ],
  });
}

async function mountTable(storage: StorageRow[]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = makeRouter();
  router.push('/storage');
  await router.isReady();
  return mount(StorageTable, {
    props: { storage },
    global: { plugins: [router, [VueQueryPlugin, { queryClient }]] },
  });
}

const zeroUsage = {
  deleted: { count: 0, size: 0 },
  missing: { count: 0, size: 0 },
  pending: { count: 0, size: 0 },
  present: { count: 0, size: 0 },
  purged: { count: 0, size: 0 },
};

const row: StorageRow = {
  prefix: 'org/my-repo',
  owner: 'org',
  repo: 'my-repo',
  status: 'used',
  name: 'org/my-repo',
  firstSeen: '2026-01-15T00:00:00Z',
  updatedAt: '2026-05-24T12:00:00Z',
  lastChangeAt: '2026-05-24T12:00:00Z',
  unusedAt: null,
  archivedAt: null,
  backedUpAt: null,
  backupComplete: false,
  clearedAt: null,
  purgedAt: null,
  activeOp: null,
  gitRepo: { owner: 'org', repo: 'my-repo', status: 'active' },
  willArchiveAt: null,
  willPurgeAt: null,
  lastAccessedAt: '2026-05-24T12:00:00Z',
  usage: { ...zeroUsage, present: { count: 142, size: 1073741824 } },
};

const unused = { ...row, status: 'unused' as const, unusedAt: '2026-05-20T00:00:00Z' };
const archived = { ...unused, archivedAt: '2026-05-25T00:00:00Z' };

// Hovering (or focusing) a trigger opens its hover-card; reka opens after openDelay, so drive fake
// timers past the delay. The card content is teleported into document.body.
const openHoverCard = async (trigger: ReturnType<ReturnType<typeof mount>['find']>) => {
  vi.useFakeTimers();
  await trigger.trigger('focus');
  vi.advanceTimersByTime(1000);
  vi.useRealTimers();
  await flushPromises();
};

describe('StorageTable', () => {
  it('renders prefix rows', async () => {
    const wrapper = await mountTable([row]);
    expect(wrapper.text()).toContain('org/my-repo');
  });

  it('renders the stored size, with the object breakdown on hover', async () => {
    const wrapper = await mountTable([row]);
    expect(wrapper.text()).toContain('1.07 GB');
    // The object count lives in the Size hover, not a column.
    const size = wrapper.find('td:nth-child(3) [data-slot="hover-card-trigger"]');
    await openHoverCard(size);
    expect(document.body.textContent).toContain('142 objects');
    expect(document.body.textContent).toContain('present');
    wrapper.unmount();
  });

  it('links the matching git repo; an orphan prefix badges missing', async () => {
    const linked = await mountTable([row]);
    const link = linked.find('a[href="/repos"]');
    expect(link.exists()).toBe(true);
    expect(link.text()).toBe('org/my-repo');

    // No tracked git repo → the prefix is itself `missing`, badged with no link.
    const orphan = await mountTable([{ ...unused, gitRepo: null }]);
    expect(orphan.find('a[href="/repos"]').exists()).toBe(false);
    expect(orphan.find('td:nth-child(2)').text()).toContain('missing');
  });

  it('badges a missing git repo in the Repo column', async () => {
    const missing = await mountTable([
      { ...row, gitRepo: { owner: 'org', repo: 'my-repo', status: 'missing' } },
    ]);
    expect(missing.find('td:nth-child(2)').text()).toContain('missing');
    // Active repos are the norm — not badged.
    const active = await mountTable([row]);
    expect(active.find('td:nth-child(2)').text()).not.toContain('missing');
  });

  it('renders size for empty usage', async () => {
    const emptyRow = { ...row, usage: zeroUsage };
    const wrapper = await mountTable([emptyRow]);
    expect(wrapper.findAll('td')[2].text()).toBe('0 B');
  });

  it('renders willArchiveAt as a date with full timestamp on hover', async () => {
    const wrapper = await mountTable([{ ...unused, willArchiveAt: '2026-05-27T00:00:00Z' }]);
    const cell = wrapper.find('td:nth-child(5)');
    // Date sits in flow; the hover-card trigger is the (overlaid) Archive button.
    expect(cell.text()).toContain(new Date('2026-05-27T00:00:00Z').toLocaleDateString());
    await openHoverCard(cell.find('[data-slot="hover-card-trigger"]'));
    expect(document.body.textContent).toContain(new Date('2026-05-27T00:00:00Z').toLocaleString());
    wrapper.unmount();
  });

  it('renders lastAccessed relative with absolute timestamp on hover', async () => {
    const recent = { ...row, lastAccessedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString() };
    const wrapper = await mountTable([recent]);
    const trigger = wrapper.find('td:nth-child(4) [data-slot="hover-card-trigger"]');
    expect(trigger.text()).toBe('5m ago');
    await openHoverCard(trigger);
    expect(document.body.textContent).toContain(new Date(recent.lastAccessedAt).toLocaleString());
    wrapper.unmount();
  });

  it('renders dash for null lastAccessedAt', async () => {
    const wrapper = await mountTable([{ ...row, lastAccessedAt: null }]);
    expect(wrapper.find('td:nth-child(4)').text()).toBe('—');
  });

  const actionLabels = async (storage: StorageRow[]) =>
    (await mountTable(storage)).findAll('button').map((b) => b.text());

  it('shows Archive (hover-reveal) for unused, not-yet-archived prefixes only', async () => {
    expect(await actionLabels([unused])).toContain('Archive');
    expect(await actionLabels([row])).not.toContain('Archive'); // used
    expect(await actionLabels([archived])).not.toContain('Archive'); // already archived
  });

  it('shows Restore (hover-reveal) whenever the prefix is archived, regardless of status', async () => {
    expect(await actionLabels([archived])).toContain('Restore');
    expect(await actionLabels([unused])).not.toContain('Restore');
    expect(await actionLabels([row])).not.toContain('Restore'); // used, not archived
  });

  it('overlays the Will-archive text with the Archive trigger on hover/open', async () => {
    const cell = (await mountTable([{ ...unused, willArchiveAt: '2026-05-27T00:00:00Z' }])).find(
      'td:nth-child(5)',
    );
    // The date stays in flow (constant width); the trigger is an absolute overlay revealed on
    // hover and kept while its popover is open.
    expect(cell.text()).toContain(new Date('2026-05-27T00:00:00Z').toLocaleDateString());
    const archiveBtn = cell.findAll('button').find((b) => b.text() === 'Archive');
    expect(archiveBtn!.classes()).toEqual(
      expect.arrayContaining([
        'absolute',
        'hidden',
        'group-hover:inline-flex',
        'data-[state=open]:inline-flex',
      ]),
    );
  });

  it('shows Purge for any non-purged storage; purged shows a badge instead', async () => {
    expect(await actionLabels([row])).toContain('Purge');
    const purged = await mountTable([
      { ...row, status: 'purged', purgedAt: '2026-05-26T00:00:00Z' },
    ]);
    expect(purged.findAll('button').map((b) => b.text())).not.toContain('Purge');
    expect(purged.find('td:nth-child(6)').text()).toContain('purged');
  });

  // The confirm action + Cancel + the action description live in the teleported popover
  // (document.body). Detect popover open/close via its content slot.
  const bodyButtons = () => [...document.body.querySelectorAll('button')];
  const popoverOpen = () => document.body.querySelector('[data-slot="popover-content"]') !== null;

  it('opens a confirm popover on Archive carrying the action, Cancel, and its description', async () => {
    const wrapper = await mountTable([unused]);
    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'Archive')!
      .trigger('click');
    await flushPromises();
    expect(popoverOpen()).toBe(true);
    expect(bodyButtons().map((b) => b.textContent?.trim())).toEqual(
      expect.arrayContaining(['Archive', 'Cancel']),
    );
    expect(document.body.textContent).toContain('Stops this storage from serving Git LFS');
    wrapper.unmount();
  });

  it('Cancel dismisses the confirm popover', async () => {
    const wrapper = await mountTable([unused]);
    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'Archive')!
      .trigger('click');
    await flushPromises();
    expect(popoverOpen()).toBe(true);
    bodyButtons()
      .find((b) => b.textContent?.trim() === 'Cancel')!
      .click();
    await flushPromises();
    expect(popoverOpen()).toBe(false);
    wrapper.unmount();
  });

  it('Esc dismisses the confirm popover', async () => {
    const wrapper = await mountTable([unused]);
    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'Archive')!
      .trigger('click');
    await flushPromises();
    expect(popoverOpen()).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flushPromises();
    expect(popoverOpen()).toBe(false);
    wrapper.unmount();
  });

  it('explains Purge on hover and confirms in a popover with Purge disabled', async () => {
    const wrapper = await mountTable([row]);
    const cell = wrapper.find('td:nth-child(6)');
    // Hover-card trigger is the cell span; its hover carries the warning.
    await openHoverCard(cell.find('[data-slot="hover-card-trigger"]'));
    expect(document.body.textContent).toContain('Permanently deletes every file');
    // Click opens the confirm popover; the Purge confirm stays disabled (not implemented).
    await cell
      .findAll('button')
      .find((b) => b.text() === 'Purge')!
      .trigger('click');
    await flushPromises();
    const action = bodyButtons().find(
      (b) => b.textContent?.trim() === 'Purge' && b.hasAttribute('disabled'),
    );
    expect(action).toBeTruthy();
    wrapper.unmount();
  });

  it('renders an Archived badge when archived', async () => {
    expect((await mountTable([archived])).text()).toContain('archived');
    expect((await mountTable([row])).text()).not.toContain('archived');
  });
});
