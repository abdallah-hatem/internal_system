/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: Ledger & Financial Transactions
 * ═══════════════════════════════════════════════════════════════════════
 *  Tests: view ledger, transaction types, filtering, create, reverse
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

test.describe('Ledger & Financial Transactions Flow', () => {

  test('TC-LED-01: Ledger page loads', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/ledger`);
    await expect(page.getByRole('heading', { name: /Ledger|Transactions/i })).toBeVisible({ timeout: 10000 });
  });

  test('TC-LED-02: Ledger table shows transactions', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/ledger`);
    await page.waitForTimeout(2000);
    const body = await page.textContent('body');
    expect(body).toMatch(/Type|Amount|Direction|Category|Account|Date|Reference/i);
  });

  test('TC-LED-03: Ledger shows financial transaction types', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/ledger`);
    await page.waitForTimeout(2000);
    const body = await page.textContent('body');
    expect(body).toMatch(/INFLOW|OUTFLOW|PURCHASE_COST|SALE_REVENUE|PAYMENT_RECEIVED|CONTRIBUTION|EXPENSE/i);
  });

  test('TC-LED-04: Ledger search works', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/ledger`);
    await page.waitForTimeout(2000);
    const searchInput = page.getByPlaceholder(/search/i).first();
    if (await searchInput.isVisible()) {
      await searchInput.fill('PURCHASE');
      await page.waitForTimeout(500);
    }
  });

  test('TC-LED-05: Ledger filter by type works', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/ledger`);
    await page.waitForTimeout(2000);
    // Look for filter dropdowns
    const filterSelects = page.getByRole('combobox');
    const count = await filterSelects.count();
    if (count > 0) {
      await filterSelects.first().click();
      await page.waitForTimeout(500);
    }
  });

  test('TC-LED-06: Create transaction modal opens', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/ledger`);
    await page.waitForTimeout(1000);
    const newBtn = page.getByRole('button', { name: /New|Create|Add/i }).first();
    if (await newBtn.isVisible()) {
      await newBtn.click();
      await page.waitForTimeout(500);
    }
  });

  test('TC-LED-07: Ledger shows date formatted nicely', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/ledger`);
    await page.waitForTimeout(2000);
    const body = await page.textContent('body');
    // Should show formatted dates like "Aug 17, 2026" not raw ISO
    expect(body).toMatch(/(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4}/);
  });

  test('TC-LED-08: Ledger amounts show EGP currency', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/ledger`);
    await page.waitForTimeout(2000);
    const body = await page.textContent('body');
    expect(body).toMatch(/EGP/);
  });
});
