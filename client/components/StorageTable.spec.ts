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

async function mountTable(storage: StorageRow[], highlight?: string, coldStorage?: boolean) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = makeRouter();
  router.push('/storage');
  await router.isReady();
  return mount(StorageTable, {
    props: { storage, highlight, coldStorage },
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
  purgeConfirmBy: null,
  lastAccessedAt: '2026-05-24T12:00:00Z',
  usage: { ...zeroUsage, present: { count: 142, size: 1073741824 } },
};

const unused = { ...row, status: 'unused' as const, unusedAt: '2026-05-20T00:00:00Z' };
const archived = { ...unused, archivedAt: '2026-05-25T00:00:00Z' };
const purging = {
  ...archived,
  activeOp: 'purge' as const,
  // +49h so the floor-based countdown lands on a stable "2 d" regardless of test runtime.
  purgeConfirmBy: new Date(Date.now() + 49 * 60 * 60 * 1000).toISOString(),
};

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
    const size = wrapper.find('[data-slot="metrics"] [data-slot="hover-card-trigger"]');
    await openHoverCard(size);
    expect(document.body.textContent).toContain('142 objects');
    expect(document.body.textContent).toContain('present');
    wrapper.unmount();
  });

  it('badges a used prefix and names its repo in the hover', async () => {
    const wrapper = await mountTable([row]);
    const status = wrapper.find('[data-slot="status"]');
    expect(status.text()).toContain('used');
    // The repo it serves lives in the badge hover, not inline.
    await openHoverCard(status.find('[data-slot="hover-card-trigger"]'));
    const link = [...document.body.querySelectorAll('a[href="/repos"]')];
    expect(link.map((a) => a.textContent)).toContain('org/my-repo');
    wrapper.unmount();
  });

  it('badges an unused prefix (orphan or repo-missing) without a repo link', async () => {
    const orphan = await mountTable([{ ...unused, gitRepo: null }]);
    expect(orphan.find('[data-slot="status"]').text()).toContain('unused');
    expect(orphan.find('a[href="/repos"]').exists()).toBe(false);
  });

  it('renders size for empty usage', async () => {
    const emptyRow = { ...row, usage: zeroUsage };
    const wrapper = await mountTable([emptyRow]);
    expect(wrapper.find('[data-slot="metrics"] [data-slot="hover-card-trigger"]').text()).toBe(
      '0 B',
    );
  });

  it('renders the auto-archive deadline relative in the metrics row, full timestamp once on hover', async () => {
    // +49h floors to a stable "2 d" countdown regardless of test runtime.
    const willArchiveAt = new Date(Date.now() + 49 * 60 * 60 * 1000).toISOString();
    const wrapper = await mountTable([{ ...unused, willArchiveAt }]);
    const metrics = wrapper.find('[data-slot="metrics"]');
    expect(metrics.text()).toContain('Archiving in');
    // The relative deadline is the last metrics hover trigger (Size, Last accessed, Archiving).
    const triggers = metrics.findAll('[data-slot="hover-card-trigger"]');
    expect(triggers.at(-1)!.text()).toBe('2 d');
    await openHoverCard(triggers.at(-1)!);
    // The full timestamp shows once — the old tooltip duplicated the date.
    const ts = new Date(willArchiveAt).toLocaleString();
    expect(document.body.textContent!.split(ts).length - 1).toBe(1);
    wrapper.unmount();
  });

  it('renders lastAccessed relative with absolute timestamp on hover', async () => {
    const recent = { ...row, lastAccessedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString() };
    const wrapper = await mountTable([recent]);
    // Metrics carries two hover triggers — Size, then Last accessed.
    const trigger = wrapper.findAll('[data-slot="metrics"] [data-slot="hover-card-trigger"]')[1];
    expect(trigger.text()).toBe('5 m ago');
    await openHoverCard(trigger);
    expect(document.body.textContent).toContain(new Date(recent.lastAccessedAt).toLocaleString());
    wrapper.unmount();
  });

  it('renders dash for null lastAccessedAt', async () => {
    const wrapper = await mountTable([{ ...row, lastAccessedAt: null }]);
    // Only Size keeps a hover trigger; Last accessed collapses to a plain dash.
    expect(wrapper.findAll('[data-slot="metrics"] [data-slot="hover-card-trigger"]')).toHaveLength(
      1,
    );
    expect(wrapper.find('[data-slot="metrics"]').text()).toContain('—');
  });

  const actionLabels = async (storage: StorageRow[]) =>
    (await mountTable(storage)).findAll('button').map((b) => b.text());

  it('shows Archive for unused, not-yet-archived prefixes only', async () => {
    expect(await actionLabels([unused])).toContain('Archive');
    expect(await actionLabels([row])).not.toContain('Archive'); // used
    expect(await actionLabels([archived])).not.toContain('Archive'); // already archived
  });

  it('shows Restore for archived prefixes, but not once purged', async () => {
    expect(await actionLabels([archived])).toContain('Restore');
    expect(await actionLabels([unused])).not.toContain('Restore');
    expect(await actionLabels([row])).not.toContain('Restore'); // used, not archived
    // Purged keeps `archivedAt` but is terminal — no Restore.
    const purged = { ...archived, status: 'purged' as const, purgedAt: '2026-05-26T00:00:00Z' };
    expect(await actionLabels([purged])).not.toContain('Restore');
  });

  it('shows an always-visible Archive button in a ButtonGroup beside the deadline', async () => {
    const willArchiveAt = new Date(Date.now() + 49 * 60 * 60 * 1000).toISOString();
    const wrapper = await mountTable([{ ...unused, willArchiveAt }]);
    // The deadline lives in the metrics row; the action stays in the lifecycle column.
    expect(wrapper.find('[data-slot="metrics"]').text()).toContain('Archiving in');
    const cell = wrapper.find('[data-slot="lifecycle"]');
    // Archive is a plain button in a ButtonGroup — not the old absolute hover-reveal overlay.
    const archiveBtn = cell.findAll('button').find((b) => b.text() === 'Archive');
    expect(archiveBtn).toBeTruthy();
    expect(archiveBtn!.classes()).not.toContain('absolute');
    expect(archiveBtn!.classes()).not.toContain('hidden');
    expect(cell.find('[data-slot="button-group"]').exists()).toBe(true);
  });

  it('offers Purge only via the "…" overflow for unused storage; used and purged show a badge', async () => {
    // Purge is no longer a column button — it lives in the "…" DropdownMenu.
    const unusedW = await mountTable([unused]);
    const cell = unusedW.find('[data-slot="lifecycle"]');
    expect(cell.findAll('button').map((b) => b.text())).not.toContain('Purge');
    await moreTrigger(cell)!.trigger('click');
    await flushPromises();
    expect(menuItemEls().map((el) => el.textContent?.trim())).toContain('Purge…');
    unusedW.unmount();

    // Used storage is actively serving — no lifecycle actions, just the "used" badge (top-right).
    const used = await mountTable([row]);
    expect(used.find('[data-slot="status"]').text()).toContain('used');
    expect(moreTrigger(used.find('[data-slot="lifecycle"]'))).toBeUndefined();

    const purged = await mountTable([
      { ...row, status: 'purged', purgedAt: '2026-05-26T00:00:00Z' },
    ]);
    expect(purged.find('[data-slot="status"]').text()).toContain('purged');
  });

  // Clicking an action swaps the buttons in place for an inline {confirm} | Cancel pair plus a
  // description — all rendered within the lifecycle cell, not teleported.
  const confirmBox = (cell: ReturnType<ReturnType<typeof mount>['find']>) =>
    cell.find('[data-slot="confirm"]');

  // Purge lives behind the "…" overflow: open the DropdownMenu (teleported), then select its Purge
  // item, which swaps in the inline confirm.
  const moreTrigger = (cell: ReturnType<ReturnType<typeof mount>['find']>) =>
    cell.findAll('button').find((b) => b.attributes('aria-label') === 'More actions');
  const menuItemEls = () => [...document.body.querySelectorAll('[data-slot="dropdown-menu-item"]')];
  const openPurgeConfirm = async (cell: ReturnType<ReturnType<typeof mount>['find']>) => {
    await moreTrigger(cell)!.trigger('click');
    await flushPromises();
    (menuItemEls().find((el) => el.textContent?.includes('Purge')) as HTMLElement).click();
    await flushPromises();
  };

  it('swaps Archive in place for an inline confirm carrying the action, Cancel, and description', async () => {
    const wrapper = await mountTable([unused]);
    const cell = wrapper.find('[data-slot="lifecycle"]');
    await cell
      .findAll('button')
      .find((b) => b.text() === 'Archive')!
      .trigger('click');
    const box = confirmBox(cell);
    expect(box.exists()).toBe(true);
    expect(box.findAll('button').map((b) => b.text())).toEqual(
      expect.arrayContaining(['Archive', 'Cancel']),
    );
    // The description is a full-width row below the buttons (not inside the lifecycle cell).
    expect(wrapper.find('[data-slot="confirm-description"]').text()).toContain(
      'Stops this storage from serving Git LFS',
    );
    wrapper.unmount();
  });

  it('freezes row order while a confirm is open, then resumes on cancel', async () => {
    const a = { ...unused, prefix: 'org/a', repo: 'a' };
    const b = { ...unused, prefix: 'org/b', repo: 'b' };
    const prefixes = (w: ReturnType<typeof mount>) =>
      w.findAll('[data-slot="storage-list"] [data-slot="item-title"]').map((t) => t.text());

    const wrapper = await mountTable([a, b]);
    // Open a confirm on org/a, then a background poll re-sorts to [b, a].
    await wrapper
      .find('[data-slot="lifecycle"]')
      .findAll('button')
      .find((btn) => btn.text() === 'Archive')!
      .trigger('click');
    await wrapper.setProps({ storage: [b, a] } as never);
    expect(prefixes(wrapper)).toEqual(['org/a', 'org/b']); // pinned

    // Cancel releases the freeze; the incoming order takes effect.
    await wrapper
      .find('[data-slot="confirm"]')
      .findAll('button')
      .find((btn) => btn.text() === 'Cancel')!
      .trigger('click');
    expect(prefixes(wrapper)).toEqual(['org/b', 'org/a']);
    wrapper.unmount();
  });

  it('Cancel dismisses the inline confirm', async () => {
    const wrapper = await mountTable([unused]);
    const cell = wrapper.find('[data-slot="lifecycle"]');
    await cell
      .findAll('button')
      .find((b) => b.text() === 'Archive')!
      .trigger('click');
    expect(confirmBox(cell).exists()).toBe(true);
    await confirmBox(cell)
      .findAll('button')
      .find((b) => b.text() === 'Cancel')!
      .trigger('click');
    expect(confirmBox(cell).exists()).toBe(false);
    wrapper.unmount();
  });

  it('inline Purge confirm stays disabled (Archive first) for an unarchived prefix', async () => {
    const wrapper = await mountTable([unused]);
    const cell = wrapper.find('[data-slot="lifecycle"]');
    await openPurgeConfirm(cell);
    const box = confirmBox(cell);
    expect(box.exists()).toBe(true);
    const description = wrapper.find('[data-slot="confirm-description"]').text();
    expect(description).toContain('Permanently deletes every file');
    expect(description).toContain('Archive this storage first');
    // The Purge confirm stays disabled until the prefix is archived.
    const action = box.findAll('button').find((b) => b.text() === 'Purge');
    expect(action!.attributes('disabled')).toBeDefined();
    wrapper.unmount();
  });

  it('replaces the unused status badge with an Archived one when archived', async () => {
    const status = (await mountTable([archived])).find('[data-slot="status"]');
    expect(status.text()).toContain('archived');
    expect(status.text()).not.toContain('unused');
    expect((await mountTable([row])).text()).not.toContain('archived');
  });

  it('fades a highlight over the row matching the highlight deep link (case-insensitive)', async () => {
    const wrapper = await mountTable([row], row.prefix.toUpperCase());
    expect(wrapper.find('[data-slot="item"]').classes()).toContain('animate-highlight');
  });

  it('does not tint any row without a highlight', async () => {
    const wrapper = await mountTable([row]);
    expect(wrapper.find('[data-slot="item"]').classes()).not.toContain('animate-highlight');
  });

  it('enables the inline Purge confirm for an archived (purgeable) prefix', async () => {
    const wrapper = await mountTable([archived]);
    const cell = wrapper.find('[data-slot="lifecycle"]');
    await openPurgeConfirm(cell);
    const action = confirmBox(cell)
      .findAll('button')
      .find((b) => b.text() === 'Purge');
    expect(action).toBeTruthy();
    expect(action!.attributes('disabled')).toBeUndefined();
    wrapper.unmount();
  });

  // Cold-storage gating (F8): the BackUp / Clear / Delete Backup surface only renders when the
  // `coldStorage` capability flag is set.
  const backedUp = {
    ...archived,
    backedUpAt: '2026-05-25T06:00:00Z',
    backupComplete: true,
  };
  const cleared = { ...backedUp, clearedAt: '2026-05-26T00:00:00Z' };

  const openMore = async (cell: ReturnType<ReturnType<typeof mount>['find']>) => {
    await moreTrigger(cell)!.trigger('click');
    await flushPromises();
    return menuItemEls().map((el) => el.textContent?.trim());
  };

  it('hides the Backup column + cold actions when cold storage is off', async () => {
    const wrapper = await mountTable([backedUp]); // coldStorage undefined
    expect(wrapper.find('[data-slot="backup"]').exists()).toBe(false);
    expect(await openMore(wrapper.find('[data-slot="lifecycle"]'))).toEqual(['Purge…']);
    wrapper.unmount();
  });

  it('shows the Backup column with the cold-copy state when cold storage is on', async () => {
    const wrapper = await mountTable([backedUp], undefined, true);
    const chip = wrapper.find('[data-slot="backup"]');
    expect(chip.exists()).toBe(true);
    expect(chip.text()).toContain('Backup');
    // backedUpAt present + not cleared → a relative timestamp, not "live cleared" / dash.
    expect(chip.text()).not.toContain('live cleared');
    expect(chip.text()).not.toContain('—');

    const dash = await mountTable([archived], undefined, true); // no backup yet
    expect(dash.find('[data-slot="backup"]').text()).toContain('—');

    const clearedW = await mountTable([cleared], undefined, true);
    expect(clearedW.find('[data-slot="backup"]').text()).toContain('live cleared');
    wrapper.unmount();
  });

  it('offers Back up / Clear / Delete backup in the overflow, gated by cold state', async () => {
    // Backed-up + blocked + not cleared → all three plus Purge.
    const backed = await mountTable([backedUp], undefined, true);
    expect(await openMore(backed.find('[data-slot="lifecycle"]'))).toEqual([
      'Back up',
      'Clear…',
      'Delete backup…',
      'Purge…',
    ]);
    backed.unmount();

    // Archived but no backup yet → Clear/Delete hidden (need a complete backup), Back up offered.
    const noBackup = await mountTable([archived], undefined, true);
    expect(await openMore(noBackup.find('[data-slot="lifecycle"]'))).toEqual(['Back up', 'Purge…']);
    noBackup.unmount();

    // Cleared → live is gone, so neither Back up nor Delete backup; cold copy is the only copy.
    const clearedW = await mountTable([cleared], undefined, true);
    expect(await openMore(clearedW.find('[data-slot="lifecycle"]'))).toEqual(['Purge…']);
    clearedW.unmount();
  });

  it('shows a progress badge (and no action buttons) for an in-flight cold op', async () => {
    const backingUp = { ...archived, activeOp: 'backup' as const };
    const wrapper = await mountTable([backingUp], undefined, true);
    const cell = wrapper.find('[data-slot="lifecycle"]');
    expect(cell.text()).toContain('backing up');
    expect(moreTrigger(cell)).toBeUndefined(); // no overflow → no way to start a second op
    wrapper.unmount();
  });

  it('shows the in-flight Purge workflow with a countdown plus Purge now/Cancel', async () => {
    const wrapper = await mountTable([purging]);
    const cell = wrapper.find('[data-slot="lifecycle"]');
    expect(cell.text()).toContain('purging');
    expect(cell.text()).toContain('2 d'); // countdown to purgeConfirmBy
    expect(cell.findAll('button').map((b) => b.text())).toEqual(
      expect.arrayContaining(['Purge now', 'Cancel']),
    );
    // No plain Purge trigger while an op is in flight.
    expect(cell.findAll('button').map((b) => b.text())).not.toContain('Purge');
    wrapper.unmount();
  });
});
