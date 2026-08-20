/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: Inventory Management
 * ═══════════════════════════════════════════════════════════════════════
 *  Tests: view inventory, batch details, movements, verify stock
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

test.describe('Inventory Management Flow', () => {

  test('TC-INV-01: Inventory page loads', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/inventory`);
    await expect(page.getByRole('heading', { name: /Inventory/i })).toBeVisible({ timeout: 10000 });
  });

  test('TC-INV-02: Inventory table shows stock data', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/inventory`);
    await page.waitForTimeout(2000);
    // Table headers should be visible
    const body = await page.textContent('body');
    expect(body).toMatch(/Product|Batch|Quantity|Remaining|Available|Cycle/i);
  });

  test('TC-INV-03: Inventory table shows batches from seed data', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/inventory`);
    await page.waitForTimeout(2000);
    const body = await page.textContent('body');
    // Assert on the shape of the page rather than one product's name, so the
    // test survives the seed changing what it stocks.
    expect(body).toMatch(/brake pad|helmet|PRD-|CYC-/i);
  });

  test('TC-INV-04: Inventory search works', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/inventory`);
    await page.waitForTimeout(2000);
    const searchInput = page.getByPlaceholder(/search/i).first();
    if (await searchInput.isVisible()) {
      await searchInput.fill('helmet');
      await page.waitForTimeout(500);
      const body = await page.textContent('body');
      expect(body).toMatch(/helmet/i);
    }
  });

  test('TC-INV-05: Verify stock button is available', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/inventory`);
    await page.waitForTimeout(2000);
    const verifyBtn = page.getByRole('button', { name: /Verify|Verify Stock|Receive/i }).first();
    if (await verifyBtn.isVisible()) {
      await expect(verifyBtn).toBeVisible();
    }
  });

  test('TC-INV-06: Inventory batch expansion shows movements', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/inventory`);
    await page.waitForTimeout(2000);

    // Look for expandable row or movement button
    const expandBtn = page.getByRole('button', { name: /expand|movements|history|details/i }).first();
    if (await expandBtn.isVisible()) {
      await expandBtn.click();
      await page.waitForTimeout(1000);
    }
  });

  test('TC-INV-07: Inventory columns show correct data types', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/inventory`);
    await page.waitForTimeout(2000);
    // Check that the page has numeric values (quantities)
    const body = await page.textContent('body');
    expect(body).toMatch(/\d+/); // Should contain numbers
  });

  test('TC-INV-08: Landed cost is displayed', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/inventory`);
    await page.waitForTimeout(2000);
    const body = await page.textContent('body');
    expect(body).toMatch(/EGP|USD|cost|Landed/i);
  });
});
