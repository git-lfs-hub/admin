import { test, expect } from '@playwright/test';

// Regression: the Archive/Restore/Purge confirm popovers must open ON-SCREEN and be clickable.
// They share a cell with an info hover-card; an earlier structure anchored the popover to the
// hover-card's Popper instead of its own, rendering it off-viewport (clicks did nothing). We mock
// the API so /storage renders with fixtures, then exercise the real overlay → popover → POST flow.

const usage = {
  deleted: { count: 0, size: 0 },
  missing: { count: 0, size: 0 },
  pending: { count: 0, size: 0 },
  present: { count: 142, size: 1073741824 },
  purged: { count: 0, size: 0 },
};

const base = {
  name: 'org/x',
  firstSeen: '2026-01-15T00:00:00Z',
  updatedAt: '2026-05-24T12:00:00Z',
  lastChangeAt: '2026-05-24T12:00:00Z',
  unusedAt: null,
  backedUpAt: null,
  backupComplete: false,
  clearedAt: null,
  purgedAt: null,
  activeOp: null,
  willPurgeAt: null,
  lastAccessedAt: '2026-05-24T12:00:00Z',
  usage,
};

const storage = [
  {
    ...base,
    prefix: 'org/archived-repo',
    owner: 'org',
    repo: 'archived-repo',
    name: 'org/archived-repo',
    status: 'unused',
    unusedAt: '2026-05-20T00:00:00Z',
    archivedAt: '2026-05-25T00:00:00Z',
    willArchiveAt: null,
    gitRepos: [{ owner: 'org', repo: 'archived-repo', status: 'missing' }],
  },
  {
    ...base,
    prefix: 'org/unused-repo',
    owner: 'org',
    repo: 'unused-repo',
    name: 'org/unused-repo',
    status: 'unused',
    unusedAt: '2026-05-20T00:00:00Z',
    archivedAt: null,
    willArchiveAt: '2026-06-20T00:00:00Z',
    gitRepos: [{ owner: 'org', repo: 'unused-repo', status: 'missing' }],
  },
  {
    ...base,
    prefix: 'org/used-repo',
    owner: 'org',
    repo: 'used-repo',
    name: 'org/used-repo',
    status: 'used',
    archivedAt: null,
    willArchiveAt: null,
    gitRepos: [{ owner: 'org', repo: 'used-repo', status: 'active' }],
  },
];

let posted = '';

test.beforeEach(async ({ page }) => {
  posted = '';
  await page.route('**/api/me', (r) => r.fulfill({ json: { admin: { login: 'tester' } } }));
  await page.route('**/api/storage', (r) => r.fulfill({ json: { storage } }));
  await page.route('**/api/storage/**', (r) => {
    posted = new URL(r.request().url()).pathname;
    return r.fulfill({ json: { storage: storage[0] } });
  });
});

// Overlay triggers (Restore/Archive) are display:none until the cell is hovered (group-hover);
// Purge is always visible.
async function reveal(page, rowText: string) {
  const cell = page.getByRole('row').filter({ hasText: rowText }).locator('td').nth(4);
  await cell.locator('.group').hover();
  return cell;
}

test('Restore opens an on-screen confirm popover and fires the restore POST', async ({ page }) => {
  await page.goto('/storage', { waitUntil: 'networkidle' });
  const cell = await reveal(page, 'org/archived-repo');
  await cell.getByRole('button', { name: 'Restore' }).click();
  const confirm = page
    .locator('[data-slot=popover-content]')
    .getByRole('button', { name: 'Restore' });
  await expect(confirm).toBeInViewport();
  await confirm.click();
  await page.waitForTimeout(300);
  expect(posted).toContain('/restore');
});

test('Archive opens an on-screen confirm popover and fires the archive POST', async ({ page }) => {
  await page.goto('/storage', { waitUntil: 'networkidle' });
  const cell = await reveal(page, 'org/unused-repo');
  await cell.getByRole('button', { name: 'Archive' }).click();
  const confirm = page
    .locator('[data-slot=popover-content]')
    .getByRole('button', { name: 'Archive' });
  await expect(confirm).toBeInViewport();
  await confirm.click();
  await page.waitForTimeout(300);
  expect(posted).toContain('/archive');
});

test('Purge opens an on-screen confirm popover (confirm disabled)', async ({ page }) => {
  await page.goto('/storage', { waitUntil: 'networkidle' });
  const cell = page.getByRole('row').filter({ hasText: 'org/used-repo' }).locator('td').nth(5);
  await cell.getByRole('button', { name: 'Purge' }).click();
  const confirm = page
    .locator('[data-slot=popover-content]')
    .getByRole('button', { name: 'Purge' });
  await expect(confirm).toBeInViewport();
  await expect(confirm).toBeDisabled();
});

test("the action's confirm popover carries the action description", async ({ page }) => {
  await page.goto('/storage', { waitUntil: 'networkidle' });
  const cell = await reveal(page, 'org/archived-repo');
  await cell.getByRole('button', { name: 'Restore' }).click();
  const pop = page.locator('[data-slot=popover-content]');
  await expect(pop).toBeVisible();
  await expect(pop).toContainText('Unarchives this storage so it serves Git LFS again');
});

test('confirm popover is centered over the trigger, aligned like the hover-card', async ({
  page,
}) => {
  await page.goto('/storage', { waitUntil: 'networkidle' });
  const cell = await reveal(page, 'org/archived-repo');
  const trigger = cell.getByRole('button', { name: 'Restore' });
  const tb = (await trigger.boundingBox())!;
  const triggerCenter = tb.x + tb.width / 2;
  // Hover-card center (it dismisses on the click below, so measure it first).
  const card = page.locator('[data-slot=hover-card-content]');
  await expect(card).toBeVisible({ timeout: 3000 });
  const hb = (await card.boundingBox())!;
  const cardCenter = hb.x + hb.width / 2;
  await trigger.click();
  const pop = page.locator('[data-slot=popover-content]');
  await expect(pop).toBeInViewport();
  const pb = (await pop.boundingBox())!;
  const popCenter = pb.x + pb.width / 2;
  // Box is centered over the trigger, sharing the hover-card's horizontal alignment.
  expect(Math.abs(popCenter - triggerCenter)).toBeLessThanOrEqual(2);
  expect(Math.abs(popCenter - cardCenter)).toBeLessThanOrEqual(2);
  // …but within the centered box, Cancel's right edge lands on the trigger's right edge.
  const cancel = pop.getByRole('button', { name: 'Cancel' });
  const cb = (await cancel.boundingBox())!;
  expect(Math.abs(tb.x + tb.width - (cb.x + cb.width))).toBeLessThanOrEqual(2);
});

test('hover-card stays anchored to the cell — never jumps to the top-left', async ({ page }) => {
  await page.goto('/storage', { waitUntil: 'networkidle' });
  const cell = await reveal(page, 'org/archived-repo');
  const card = page.locator('[data-slot=hover-card-content]');
  await expect(card).toBeVisible({ timeout: 3000 });
  const cellBox = (await cell.boundingBox())!;
  // Move within the cell but off the trigger span (the overlay button collapses to a zero rect here;
  // the regression was the card re-anchoring to (0,0)).
  await page.mouse.move(cellBox.x + cellBox.width - 3, cellBox.y + cellBox.height / 2);
  await page.waitForTimeout(150);
  if (await card.isVisible()) expect((await card.boundingBox())!.y).toBeGreaterThan(0);
});

test('hover-card dismisses when the pointer moves onto it', async ({ page }) => {
  await page.goto('/storage', { waitUntil: 'networkidle' });
  await reveal(page, 'org/archived-repo');
  const card = page.locator('[data-slot=hover-card-content]');
  await expect(card).toBeVisible({ timeout: 3000 });
  const b = (await card.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await expect(card).toBeHidden({ timeout: 2000 });
});

test('hover-card is gone once the confirm popover opens', async ({ page }) => {
  await page.goto('/storage', { waitUntil: 'networkidle' });
  const cell = await reveal(page, 'org/archived-repo');
  await expect(page.locator('[data-slot=hover-card-content]')).toBeVisible({ timeout: 3000 });
  await cell.getByRole('button', { name: 'Restore' }).click();
  await expect(page.locator('[data-slot=popover-content]')).toBeVisible();
  await expect(page.locator('[data-slot=hover-card-content]')).toBeHidden();
});
