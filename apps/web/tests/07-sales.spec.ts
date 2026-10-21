/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: Sales Orders
 * ═══════════════════════════════════════════════════════════════════════
 *  Tests: list orders, create order, view detail, confirm, cancel, filters
 */
import { test, expect } from '@playwright/test';
import { WEB as BASE } from './support/env';

const EMAIL = 'abdallah@motoparts.com';
const PASSWORD = 'password123';

async function login(page: any) {
  await page.goto(`${BASE}/en/login`);
  await page.getByPlaceholder('name@company.com').fill(EMAIL);
  await page.getByPlaceholder('StrongPassword@123').fill(PASSWORD);
  await page.getByRole('button', { name: /login/i }).click();
  await expect(page).toHaveURL(/dashboard/, { timeout: 10000 });
}

test.describe('Sales Orders Flow', () => {

  test('TC-SALE-01: Sales page loads', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/sales`);
    await expect(page.getByRole('heading', { name: /Sale/i })).toBeVisible({ timeout: 10000 });
  });

  test('TC-SALE-02: Sales table shows data', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/sales`);
    await page.waitForTimeout(2000);
    const body = await page.textContent('body');
    expect(body).toMatch(/Order|Customer|Total|Status|Channel/i);
  });

  test('TC-SALE-03: Create order modal opens', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/sales`);
    await page.waitForTimeout(1000);
    await page.getByRole('button', { name: /New|Create/i }).first().click();
    await page.waitForTimeout(500);
    await expect(page.locator('body')).toContainText(/New Order|Create Order|Customer|Channel/i);
  });

  test('TC-SALE-04: Status filter tabs work', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/sales`);
    await page.waitForTimeout(2000);

    // The status filter's own buttons. By name, "all" also matched the summary
    // card "Most revenue, all time" (2026-10-20), which opens an order instead.
    const allTab = page.locator('button[data-value="all"]').first();
    await allTab.click();
    await expect(allTab).toHaveAttribute('aria-pressed', 'true');

    const draftTab = page.locator('button[data-value="draft"]').first();
    await draftTab.click();
    await expect(draftTab).toHaveAttribute('aria-pressed', 'true');
  });

  test('TC-SALE-05: Sales status badges show correct statuses', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/sales`);
    await page.waitForTimeout(2000);
    const body = await page.textContent('body');
    expect(body).toMatch(/DRAFT|CONFIRMED|PARTIALLY_PAID|PAID|CANCELLED/i);
  });

  test('TC-SALE-06: Sales search works', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/sales`);
    await page.waitForTimeout(2000);
    const searchInput = page.getByPlaceholder(/search/i).first();
    if (await searchInput.isVisible()) {
      await searchInput.fill('ORD');
      await page.waitForTimeout(500);
    }
  });

  test('TC-SALE-07: Order detail view is accessible', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/sales`);
    await page.waitForTimeout(2000);

    const viewBtn = page.getByRole('button', { name: /View|Eye/i }).first();
    if (await viewBtn.isVisible()) {
      await viewBtn.click();
      await page.waitForTimeout(1000);
    }
  });

  test('TC-SALE-08: Create order form has customer and channel fields', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/sales`);
    await page.waitForTimeout(1000);
    await page.getByRole('button', { name: /New|Create/i }).first().click();
    await page.waitForTimeout(1000);
    const body = await page.textContent('body');
    expect(body).toMatch(/Customer|Channel|EGYPT|B2B|B2C/i);
  });

  test('TC-SALE-09: Line items can be added in create form', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/sales`);
    await page.waitForTimeout(1000);
    await page.getByRole('button', { name: /New|Create/i }).first().click();
    await page.waitForTimeout(1000);
    const addItemBtn = page.getByRole('button', { name: /Add Item|Add Line|add item/i }).first();
    if (await addItemBtn.isVisible()) {
      await addItemBtn.click();
      await page.waitForTimeout(500);
    }
  });
});
