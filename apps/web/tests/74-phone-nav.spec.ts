/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: Getting around on a phone
 * ═══════════════════════════════════════════════════════════════════════
 *  Below 768px the app had only a hamburger in the corner and a search box
 *  that did nothing. Now a bar at the foot holds the five daily places, and
 *  "More" opens the full grouped menu. The search box is gone everywhere.
 *
 *  Everything here is reached by clicking, as a person does: a page.goto()
 *  between steps is a full load, which would hide a bar that only works on
 *  the first render.
 */
import { test, expect, Page } from '@playwright/test';
import { EMAIL, PASSWORD } from './support/fixtures';
import { WEB as BASE } from './support/env';

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };

async function login(page: Page, locale: 'en' | 'ar' = 'en') {
  await page.goto(`${BASE}/${locale}/login`);
  await page.getByPlaceholder('name@company.com').fill(EMAIL);
  await page.getByPlaceholder('StrongPassword@123').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/dashboard/, { timeout: 10000 });
}

const bar = (page: Page) => page.getByTestId('phone-bar');

test.describe('Phone navigation', () => {
  test('on a phone, the bar is visible and Sales is reached by tapping it', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await login(page);
    await expect(bar(page)).toBeVisible();
    await bar(page).getByRole('link', { name: 'Sales' }).click();
    await expect(page).toHaveURL(/\/en\/sales$/);
    await expect(bar(page).getByRole('link', { name: 'Sales' })).toHaveAttribute('aria-current', 'page');
    await expect(bar(page).getByRole('link', { name: 'Dashboard' })).not.toHaveAttribute('aria-current', 'page');
  });

  test('the bar holds exactly Dashboard, Sales, Customers, Inventory, Cycles and More', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await login(page);
    await expect(bar(page).getByRole('link')).toHaveText(['Dashboard', 'Sales', 'Customers', 'Inventory', 'Cycles']);
    await expect(bar(page).getByRole('button', { name: 'More' })).toBeVisible();
  });

  test('every bar target is at least 44px tall', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await login(page);
    const targets = bar(page).locator('a, button');
    const n = await targets.count();
    expect(n).toBe(6);
    for (let i = 0; i < n; i++) {
      const box = await targets.nth(i).boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
  });

  test('More opens the full grouped menu, and a link in it navigates and closes it', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await login(page);
    const payments = page.locator('aside').getByRole('link', { name: 'Payments' });
    await expect(payments).not.toBeInViewport();
    await bar(page).getByRole('button', { name: 'More' }).click();
    await expect(payments).toBeInViewport();
    await expect(page.locator('aside').getByText('Money', { exact: true })).toBeInViewport();
    await payments.click();
    await expect(page).toHaveURL(/\/en\/payments$/);
    await expect(payments).not.toBeInViewport();
  });

  test('More the second time: closed from the menu, it opens again', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await login(page);
    // A link from the top of the menu. Settings sits at its foot, and the menu
    // has outgrown a 844px screen (order and import requests joined it), so
    // Settings is scrolled out of sight inside the open drawer — it read as
    // "More did not open" when the drawer was open all along.
    const suppliers = page.locator('aside').getByRole('link', { name: 'Suppliers' });
    await bar(page).getByRole('button', { name: 'More' }).click();
    await expect(suppliers).toBeInViewport();
    await page.getByRole('button', { name: 'Close menu' }).click();
    await expect(suppliers).not.toBeInViewport();
    await bar(page).getByRole('button', { name: 'More' }).click();
    await expect(suppliers).toBeInViewport();
  });

  test('the last thing on a page can be scrolled clear of the bar', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await login(page);
    const main = page.locator('main');
    await main.evaluate((el) => el.scrollTo(0, el.scrollHeight));
    const last = main.locator(':scope > *').last();
    const lastBox = await last.boundingBox();
    const barBox = await bar(page).boundingBox();
    expect(lastBox!.y + lastBox!.height).toBeLessThanOrEqual(barBox!.y);
  });

  test('in Arabic the bar mirrors: Dashboard sits at the right-hand edge', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await login(page, 'ar');
    const links = bar(page).getByRole('link');
    const first = await links.first().boundingBox();
    const last = await links.last().boundingBox();
    expect(first!.x).toBeGreaterThan(last!.x);
    await expect(links.first()).toHaveAttribute('href', /\/ar\/dashboard$/);
  });

  test('on a desktop there is no phone bar', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await login(page);
    await expect(bar(page)).toBeHidden();
  });

  test('no search input anywhere in the shell, on a phone or a desktop', async ({ page }) => {
    await login(page);
    for (const size of [PHONE, DESKTOP]) {
      await page.setViewportSize(size);
      await expect(page.locator('header input')).toHaveCount(0);
      await expect(page.getByPlaceholder(/^search\.\.\.$/i)).toHaveCount(0);
    }
  });

  test('the back link on a detail page is at least 44px tall on a phone', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await login(page);
    await bar(page).getByRole('button', { name: 'More' }).click();
    await page.locator('aside').getByRole('link', { name: 'Products' }).click();
    await expect(page).toHaveURL(/\/en\/products$/);
    // The reference seed has products; on a phone each is a card with a View button.
    await page.getByRole('button', { name: 'View', exact: true }).first().click();
    await expect(page).toHaveURL(/\/en\/products\/[^/]+$/);
    const back = page.getByTestId('back-link');
    const box = await back.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  });
});
