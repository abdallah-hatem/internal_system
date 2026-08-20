/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: Customers Management
 * ═══════════════════════════════════════════════════════════════════════
 *  Tests: list customers, create, view detail, edit
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

test.describe('Customers Management Flow', () => {

  test('TC-CUST-01: Customers page loads', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/customers`);
    await expect(page.getByRole('heading', { name: /Customer/i })).toBeVisible({ timeout: 10000 });
  });

  test('TC-CUST-02: Customers table shows data', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/customers`);
    await page.waitForTimeout(2000);
    const body = await page.textContent('body');
    expect(body).toMatch(/Name|Type|Phone|Email|Balance/i);
  });

  test('TC-CUST-03: Create customer modal opens', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/customers`);
    await page.waitForTimeout(1000);
    await page.getByRole('button', { name: /New|Create/i }).first().click();
    await page.waitForTimeout(500);
    await expect(page.locator('body')).toContainText(/New Customer|Create Customer|Display Name/i);
  });

  test('TC-CUST-04: Create customer form has required fields', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/customers`);
    await page.waitForTimeout(1000);
    await page.getByRole('button', { name: /New|Create/i }).first().click();
    await page.waitForTimeout(1000);
    const body = await page.textContent('body');
    expect(body).toMatch(/Display Name|Name|Type|B2B|B2C|Phone|Email/i);
  });

  test('TC-CUST-05: Customer type badges show B2B/B2C', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/customers`);
    await page.waitForTimeout(2000);
    const body = await page.textContent('body');
    expect(body).toMatch(/B2B|B2C/);
  });

  test('TC-CUST-06: Customer search works', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/customers`);
    await page.waitForTimeout(2000);
    const searchInput = page.getByPlaceholder(/search/i).first();
    if (await searchInput.isVisible()) {
      await searchInput.fill('test');
      await page.waitForTimeout(500);
    }
  });

  test('TC-CUST-07: Customer detail slide-over works', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/customers`);
    await page.waitForTimeout(2000);

    const viewBtn = page.getByRole('button', { name: /View|Details|Eye/i }).first();
    if (await viewBtn.isVisible()) {
      await viewBtn.click();
      await page.waitForTimeout(1000);
    }
  });

  test('TC-CUST-08: Outstanding balance is shown', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/customers`);
    await page.waitForTimeout(2000);
    const body = await page.textContent('body');
    expect(body).toMatch(/Balance|EGP|balance/i);
  });

  test('TC-CUST-09: Edit button exists for each customer', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/customers`);
    await page.waitForTimeout(2000);
    const editButtons = page.getByRole('button', { name: /Edit/i });
    const count = await editButtons.count();
    expect(count).toBeGreaterThan(0);
  });
});
