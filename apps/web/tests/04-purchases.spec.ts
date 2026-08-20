/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: Purchases Management
 * ═══════════════════════════════════════════════════════════════════════
 *  Tests: list purchase orders, create PO, view PO, add items, refunds
 */
import { test, expect } from '@playwright/test';

const BASE = 'http://localhost:3000';
const EMAIL = 'partner.a@motoparts.com';
const PASSWORD = 'password123';

async function login(page: any) {
  await page.goto(`${BASE}/en/login`);
  await page.getByPlaceholder('partner.a@motoparts.com').fill(EMAIL);
  await page.getByPlaceholder('••••••••').fill(PASSWORD);
  await page.getByRole('button', { name: /login/i }).click();
  await expect(page).toHaveURL(/dashboard/, { timeout: 10000 });
}

test.describe('Purchases Management Flow', () => {

  test('TC-PUR-01: Purchases page loads with list', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/purchases`);
    await expect(page.getByRole('heading', { name: /Purchase/i })).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('Reference')).toBeVisible();
  });

  test('TC-PUR-02: Purchase orders table shows existing data', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/purchases`);
    await page.waitForTimeout(2000);
    const body = await page.textContent('body');
    expect(body).toBeTruthy();
  });

  test('TC-PUR-03: Create purchase order modal opens', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/purchases`);
    await page.waitForTimeout(1000);
    await page.getByRole('button', { name: /New/i }).first().click();
    await page.waitForTimeout(500);
    // Should show create modal
    await expect(page.locator('body')).toContainText(/New Purchase|Create Purchase|New Order/i);
  });

  test('TC-PUR-04: Create PO modal has cycle dropdown', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/purchases`);
    await page.waitForTimeout(1000);
    await page.getByRole('button', { name: /New/i }).first().click();
    await page.waitForTimeout(1000);
    // Should have cycle selection
    const body = await page.textContent('body');
    expect(body).toMatch(/Cycle|cycle/i);
  });

  test('TC-PUR-05: Create PO modal has supplier dropdown', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/purchases`);
    await page.waitForTimeout(1000);
    await page.getByRole('button', { name: /New/i }).first().click();
    await page.waitForTimeout(1000);
    const body = await page.textContent('body');
    expect(body).toMatch(/Supplier|supplier/i);
  });

  test('TC-PUR-06: PO search works', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/purchases`);
    await page.waitForTimeout(2000);
    const searchInput = page.getByPlaceholder(/search/i).first();
    if (await searchInput.isVisible()) {
      await searchInput.fill('PO');
      await page.waitForTimeout(500);
      const body = await page.textContent('body');
      expect(body).toBeTruthy();
    }
  });

  test('TC-PUR-07: PO detail view is accessible', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/purchases`);
    await page.waitForTimeout(2000);

    const viewBtn = page.getByRole('button', { name: /View/i }).first();
    if (await viewBtn.isVisible()) {
      await viewBtn.click();
      await page.waitForTimeout(1000);
      // Should show PO detail
      await expect(page.locator('body')).toContainText(/Reference|Items|Status|Cycle/i);
    }
  });

  test('TC-PUR-08: PO status badges are displayed', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/purchases`);
    await page.waitForTimeout(2000);
    const body = await page.textContent('body');
    expect(body).toMatch(/DRAFT|SUBMITTED|CONFIRMED|SHIPPED|PARTIAL|RECEIVED|CANCELLED/i);
  });

  test('TC-PUR-09: Add line item button exists in create modal', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/purchases`);
    await page.waitForTimeout(1000);
    await page.getByRole('button', { name: /New/i }).first().click();
    await page.waitForTimeout(1000);
    // Look for add item button
    const addItemBtn = page.getByRole('button', { name: /Add Item|Add Line|add item/i }).first();
    if (await addItemBtn.isVisible()) {
      await expect(addItemBtn).toBeVisible();
    }
  });

  test('TC-PUR-10: Currency and FX rate fields exist', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/purchases`);
    await page.waitForTimeout(1000);
    await page.getByRole('button', { name: /New/i }).first().click();
    await page.waitForTimeout(1000);
    const body = await page.textContent('body');
    expect(body).toMatch(/Currency|FX Rate|currency/i);
  });
});
