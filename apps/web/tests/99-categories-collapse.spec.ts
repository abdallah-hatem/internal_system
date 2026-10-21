/**
 * Categories: the arrows beside a parent hide and show its subcategories.
 *
 * They used to turn while every row stayed on screen, so "Collapse All" did
 * nothing a person could see (owner, 2026-10-15). Each test clicks and reads
 * which rows are on screen, never the arrow's state alone.
 */
import { test, expect, Page } from '@playwright/test';
import { apiCtx } from './support/fixtures';
import { WEB as BASE } from './support/env';
import { openView } from './support/ui';

const EMAIL = 'abdallah@motoparts.com';
const PASSWORD = 'password123';

async function login(page: Page) {
  await page.goto(`${BASE}/en/login`);
  await page.getByPlaceholder('name@company.com').fill(EMAIL);
  await page.getByPlaceholder('StrongPassword@123').fill(PASSWORD);
  await page.getByRole('button', { name: /login/i }).click();
  await expect(page).toHaveURL(/dashboard/, { timeout: 10000 });
}

/** A parent with two children, a grandchild under the first, and a second parent. */
async function family(request: Parameters<typeof apiCtx>[0]) {
  const { mk } = await apiCtx(request);
  // The list is sorted by name and paged. A key that shrinks as time passes
  // puts the newest family first, ahead of every earlier test's, so it is on
  // page one however many categories the run has made.
  const key = `0${9_000_000_000_000 - Date.now()}`;
  const parent = await mk('categories', { name: `${key} a Parent` });
  const childA = await mk('categories', { name: `${key} a Child A`, parentId: parent.id });
  const childB = await mk('categories', { name: `${key} a Child B`, parentId: parent.id });
  const grand = await mk('categories', { name: `${key} a Grandchild`, parentId: childA.id });
  const other = await mk('categories', { name: `${key} b Other` });
  const otherChild = await mk('categories', { name: `${key} b Other child`, parentId: other.id });
  return { parent, childA, childB, grand, other, otherChild };
}

// Categories are a tab of Products since 2026-10-18 (lib/page-views.ts), no longer a menu entry.
async function openCategories(page: Page) {
  await openView(page, 'categories');
}

const row = (page: Page, name: string) =>
  page.getByRole('main').getByText(name, { exact: true });

const arrowOf = (page: Page, name: string) =>
  page
    .getByTestId('category-row')
    .filter({ has: page.getByText(name, { exact: true }) })
    .getByTestId('toggle-children');

test.describe('Categories collapse', () => {
  test('TC-CATC-01: the page opens with every subcategory showing', async ({ page, request }) => {
    const f = await family(request);
    await login(page);
    await openCategories(page);
    for (const c of [f.parent, f.childA, f.childB, f.grand]) await expect(row(page, c.name)).toBeVisible();
  });

  test('TC-CATC-02: a parent\'s arrow hides its whole branch and brings it back; other parents are untouched', async ({
    page,
    request,
  }) => {
    const f = await family(request);
    await login(page);
    await openCategories(page);
    await expect(row(page, f.grand.name)).toBeVisible();

    await arrowOf(page, f.parent.name).click();
    await expect(row(page, f.parent.name)).toBeVisible();
    for (const c of [f.childA, f.childB, f.grand]) await expect(row(page, c.name)).toHaveCount(0);
    await expect(row(page, f.otherChild.name)).toBeVisible();

    // The second time: open again, and the grandchild comes back with it.
    await arrowOf(page, f.parent.name).click();
    for (const c of [f.childA, f.childB, f.grand]) await expect(row(page, c.name)).toBeVisible();
  });

  test('TC-CATC-03: a child collapsed inside an open parent stays collapsed when the parent closes and reopens', async ({
    page,
    request,
  }) => {
    const f = await family(request);
    await login(page);
    await openCategories(page);
    await arrowOf(page, f.childA.name).click();
    await expect(row(page, f.grand.name)).toHaveCount(0);
    await expect(row(page, f.childB.name)).toBeVisible();

    await arrowOf(page, f.parent.name).click();
    await arrowOf(page, f.parent.name).click();
    await expect(row(page, f.childA.name)).toBeVisible();
    await expect(row(page, f.grand.name)).toHaveCount(0);
  });

  test('TC-CATC-04: Collapse All leaves only top-level rows; Expand All brings everything back', async ({
    page,
    request,
  }) => {
    const f = await family(request);
    await login(page);
    await openCategories(page);
    const all = page.getByTestId('toggle-all');
    await expect(all).toHaveText(/collapse all/i);

    await all.click();
    await expect(all).toHaveText(/expand all/i);
    for (const c of [f.parent, f.other]) await expect(row(page, c.name)).toBeVisible();
    for (const c of [f.childA, f.childB, f.grand, f.otherChild]) await expect(row(page, c.name)).toHaveCount(0);

    await all.click();
    await expect(all).toHaveText(/collapse all/i);
    for (const c of [f.childA, f.childB, f.grand, f.otherChild]) await expect(row(page, c.name)).toBeVisible();
  });

  test('TC-CATC-05: a search finds a subcategory even when its parent is collapsed, and clearing it restores the collapse', async ({
    page,
    request,
  }) => {
    const f = await family(request);
    await login(page);
    await openCategories(page);
    await page.getByTestId('toggle-all').click();
    await expect(row(page, f.grand.name)).toHaveCount(0);

    const search = page.getByRole('main').getByRole('textbox').first();
    await search.pressSequentially(f.grand.name);
    await expect(row(page, f.grand.name)).toBeVisible();
    await expect(row(page, f.parent.name)).toBeVisible();

    await search.fill('');
    await expect(row(page, f.parent.name)).toBeVisible();
    await expect(row(page, f.grand.name)).toHaveCount(0);
  });

  test('TC-CATC-06: the Expand/Collapse All button has a white background, not the page grey', async ({ page, request }) => {
    await family(request);
    await login(page);
    await openCategories(page);
    const bg = await page.getByTestId('toggle-all').evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).toBe('rgb(255, 255, 255)');
  });

  test('TC-CATC-07: a category shows how many products it holds, and a parent counts only its own', async ({
    page,
    request,
  }) => {
    // The badge read a count the category list never sent, so it never showed.
    const f = await family(request);
    const { mk } = await apiCtx(request);
    for (const n of [1, 2]) await mk('products', { name: `${f.childA.name} part ${n}`, minStock: 0, categoryId: f.childA.id });
    await login(page);
    await openCategories(page);
    const rowOf = (name: string) =>
      page.getByTestId('category-row').filter({ has: page.getByText(name, { exact: true }) });
    await expect(rowOf(f.childA.name)).toContainText('2 products');
    await expect(rowOf(f.parent.name)).not.toContainText(/product/);
    await expect(rowOf(f.childB.name)).not.toContainText(/product/);
  });
});
