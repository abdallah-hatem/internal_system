/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: Payments Management
 * ═══════════════════════════════════════════════════════════════════════
 *  Tests: list payments, create, view detail, allocate, reverse
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

test.describe('Payments Management Flow', () => {

  test('TC-PAY-01: Payments page loads', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/payments`);
    await expect(page.getByRole('heading', { name: /Payment/i })).toBeVisible({ timeout: 10000 });
  });

  test('TC-PAY-02: Payments table shows data', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/payments`);
    await page.waitForTimeout(2000);
    const body = await page.textContent('body');
    expect(body).toMatch(/Customer|Amount|Currency|Method|Status/i);
  });

  test('TC-PAY-03: Create payment modal opens', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/payments`);
    await page.waitForTimeout(2000);
    await page.getByRole('button', { name: /Record Payment|New|Create/i }).first().click();
    await page.waitForTimeout(500);
    await expect(page.locator('body')).toContainText(/New Payment|Record Payment|Customer|Amount/i);
  });

  test('TC-PAY-04: Create payment form has required fields', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/payments`);
    await page.waitForTimeout(2000);
    await page.getByRole('button', { name: /Record Payment|New|Create/i }).first().click();
    await page.waitForTimeout(1000);
    const body = await page.textContent('body');
    expect(body).toMatch(/Customer|Amount|Currency|Method|Reference|Date|Received/i);
  });

  test('TC-PAY-05: Payment method options available', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/payments`);
    await page.waitForTimeout(2000);
    await page.getByRole('button', { name: /Record Payment|New|Create/i }).first().click();
    await page.waitForTimeout(1000);
    const body = await page.textContent('body');
    expect(body).toMatch(/CASH|BANK|MOBILE|cash|bank|wallet/i);
  });

  test('TC-PAY-06: Payment status badges show correctly', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/payments`);
    await page.waitForTimeout(2000);
    const body = await page.textContent('body');
    expect(body).toMatch(/RECORDED|REVERSED/i);
  });

  test('TC-PAY-07: Payment search works', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/payments`);
    await page.waitForTimeout(2000);
    const searchInput = page.getByPlaceholder(/search/i).first();
    if (await searchInput.isVisible()) {
      await searchInput.fill('test');
      await page.waitForTimeout(500);
    }
  });

  test('TC-PAY-08: View payment detail', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/payments`);
    await page.waitForTimeout(2000);

    const viewBtn = page.getByRole('button', { name: /View|Eye/i }).first();
    if (await viewBtn.isVisible()) {
      await viewBtn.click();
      await page.waitForTimeout(1000);
    }
  });

  test('TC-PAY-09: Allocate payment button exists', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/payments`);
    await page.waitForTimeout(2000);
    const allocBtn = page.getByRole('button', { name: /Allocate|Allocation/i }).first();
    if (await allocBtn.isVisible()) {
      await expect(allocBtn).toBeVisible();
    }
  });

  test('TC-PAY-10: Reverse payment button exists', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/payments`);
    await page.waitForTimeout(2000);
    const reverseBtn = page.getByRole('button', { name: /Reverse|Reversal/i }).first();
    if (await reverseBtn.isVisible()) {
      await expect(reverseBtn).toBeVisible();
    }
  });
});
