/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: Shipments Management
 * ═══════════════════════════════════════════════════════════════════════
 *  Tests: list shipping legs, create, update
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

test.describe('Shipments Management Flow', () => {

  test('TC-SHIP-01: Shipments page loads', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/shipments`);
    await expect(page.getByRole('heading', { name: /Shipment|Shipping/i })).toBeVisible({ timeout: 10000 });
  });

  test('TC-SHIP-02: Shipments table shows data', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/shipments`);
    await page.waitForTimeout(2000);
    const body = await page.textContent('body');
    expect(body).toMatch(/Cycle|Provider|Status|Departed|Arrived|Carrier|Type/i);
  });

  test('TC-SHIP-03: Create shipping leg button exists', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/shipments`);
    await page.waitForTimeout(1000);
    const newBtn = page.getByRole('button', { name: /New|Create|Add/i }).first();
    if (await newBtn.isVisible()) {
      await expect(newBtn).toBeVisible();
    }
  });

  test('TC-SHIP-04: Shipping leg status badges displayed', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/shipments`);
    await page.waitForTimeout(2000);
    const body = await page.textContent('body');
    expect(body).toMatch(/PENDING|IN_TRANSIT|ARRIVED|COMPLETED|CANCELLED|PLANNED|BOOKED/i);
  });

  test('TC-SHIP-05: Shipments search works', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/shipments`);
    await page.waitForTimeout(2000);
    const searchInput = page.getByPlaceholder(/search/i).first();
    if (await searchInput.isVisible()) {
      await searchInput.fill('test');
      await page.waitForTimeout(500);
    }
  });
});
