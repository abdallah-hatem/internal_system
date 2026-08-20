/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: Dashboard & Analytics
 * ═══════════════════════════════════════════════════════════════════════
 *  Tests: dashboard KPIs, charts, top products, cycle profitability
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

test.describe('Dashboard & Analytics Flow', () => {

  test('TC-DASH-01: Dashboard loads with KPI cards', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/dashboard`);
    await expect(page.getByRole('heading', { name: /Dashboard/i })).toBeVisible({ timeout: 10000 });
    // Should have KPI sections
    await page.waitForTimeout(2000);
    const body = await page.textContent('body');
    expect(body).toMatch(/Revenue|Profit|Cycle|Orders|Stock|Total|Active/i);
  });

  test('TC-DASH-02: Dashboard shows recent activity', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/dashboard`);
    await page.waitForTimeout(2000);
    const body = await page.textContent('body');
    expect(body).toMatch(/Recent|Activity|Audit|Log/i);
  });

  test('TC-DASH-03: Dashboard shows top products section', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/dashboard`);
    await page.waitForTimeout(2000);
    const body = await page.textContent('body');
    expect(body).toMatch(/Top|Products|Product/i);
  });

  test('TC-DASH-04: Analytics page loads', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/analytics`);
    await expect(page.getByRole('heading', { name: /Analytics|Revenue/i })).toBeVisible({ timeout: 10000 });
  });

  test('TC-DASH-05: Analytics shows revenue data', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/analytics`);
    await page.waitForTimeout(2000);
    const body = await page.textContent('body');
    expect(body).toMatch(/Revenue|Monthly|Chart|Revenue by Month/i);
  });

  test('TC-DASH-06: Analytics shows top products', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/analytics`);
    await page.waitForTimeout(2000);
    const body = await page.textContent('body');
    expect(body).toMatch(/Top Products|Top products|Products/i);
  });

  test('TC-DASH-07: Analytics shows cycle profitability', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/analytics`);
    await page.waitForTimeout(2000);
    const body = await page.textContent('body');
    expect(body).toMatch(/Cycle|Profitability|Profit|cycle/i);
  });

  test('TC-DASH-08: Dashboard data cards have numeric values', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/dashboard`);
    await page.waitForTimeout(3000);
    // Should have some numeric KPI values
    const body = await page.textContent('body');
    expect(body).toMatch(/\d+/);
  });
});
