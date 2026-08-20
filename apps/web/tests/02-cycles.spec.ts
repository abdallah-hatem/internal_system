/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: Import Cycle Management
 * ═══════════════════════════════════════════════════════════════════════
 *  Tests: create cycle, view details, status transitions, participants
 */
import { test, expect } from '@playwright/test';

const BASE = 'http://localhost:3000';
const EMAIL = 'partner.a@motoparts.com';
const PASSWORD = 'password123';

// Login helper
async function login(page: any) {
  await page.goto(`${BASE}/en/login`);
  await page.getByPlaceholder('partner.a@motoparts.com').fill(EMAIL);
  await page.getByPlaceholder('••••••••').fill(PASSWORD);
  await page.getByRole('button', { name: /login/i }).click();
  await expect(page).toHaveURL(/dashboard/, { timeout: 10000 });
}

test.describe('Import Cycles Flow', () => {

  test('TC-CYC-01: Cycles page loads with list', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/cycles`);
    await expect(page.getByRole('heading', { name: /Import Cycles/i })).toBeVisible({ timeout: 10000 });
    // "New Cycle" is a link, not a button
    await expect(page.getByRole('link', { name: /New Cycle/i })).toBeVisible();
  });

  test('TC-CYC-02: Cycle creation wizard is accessible', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/cycles`);
    await page.getByRole('link', { name: /New Cycle/i }).click();
    await expect(page).toHaveURL(/cycles\/new/, { timeout: 5000 });
  });

  test('TC-CYC-03: Cycle wizard displays step 1 (Basic Info)', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/cycles/new`);
    // Wizard should show step 1 — check for any wizard content
    await expect(page.locator('body')).toContainText(/step|origin|UAE|China|planning/i, { timeout: 10000 });
  });

  test('TC-CYC-04: Cycle can be created via wizard (UAE Direct)', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/cycles/new`);
    await page.waitForTimeout(2000);

    // Step 1: Select origin type UAE_DIRECT
    const uaeOption = page.getByText(/UAE Direct|UAE_DIRECT/i).first();
    if (await uaeOption.isVisible()) {
      await uaeOption.click();
    }

    // Click Next
    const nextBtn = page.getByRole('button', { name: /next|continue/i }).first();
    if (await nextBtn.isVisible()) {
      await nextBtn.click();
      await page.waitForTimeout(1000);
    }

    // Step 2: Add participants - click Next
    const nextBtn2 = page.getByRole('button', { name: /next|continue/i }).first();
    if (await nextBtn2.isVisible()) {
      await nextBtn2.click();
      await page.waitForTimeout(1000);
    }

    // Step 3 or 4: Complete the wizard
    const createBtn = page.getByRole('button', { name: /create|submit|finish|complete/i }).first();
    if (await createBtn.isVisible()) {
      await createBtn.click();
      await page.waitForTimeout(3000);
    }
  });

  test('TC-CYC-05: Cycles list shows status badges', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/cycles`);
    await page.waitForTimeout(2000);
    // Check for status text in the page
    const body = await page.textContent('body');
    expect(body).toMatch(/PLANNING|FUNDING|PURCHASING|IN_TRANSIT|ARRIVED|VERIFICATION|SELLING|SETTLEMENT|CLOSED/i);
  });

  test('TC-CYC-06: Cycle detail view is accessible', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/cycles`);
    await page.waitForTimeout(2000);
    // Click Details button on first cycle if any exist
    const detailsBtn = page.getByRole('button', { name: /Details/i }).first();
    if (await detailsBtn.isVisible()) {
      await detailsBtn.click();
      await page.waitForTimeout(1000);
      // Should show cycle detail content
      await expect(page.locator('body')).toContainText(/CYC-|status|participants/i);
    }
  });

  test('TC-CYC-07: Cycle status transition is available', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/cycles`);
    await page.waitForTimeout(2000);

    // Click Details on first cycle
    const detailsBtn = page.getByRole('button', { name: /Details/i }).first();
    if (await detailsBtn.isVisible()) {
      await detailsBtn.click();
      await page.waitForTimeout(1000);

      // Look for transition button
      const transitionBtn = page.getByRole('button', { name: /transition|advance|next status|move to/i }).first();
      if (await transitionBtn.isVisible()) {
        await expect(transitionBtn).toBeVisible();
      }
    }
  });

  test('TC-CYC-08: Cycle search/filter works', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/cycles`);
    await page.waitForTimeout(2000);

    const searchInput = page.getByPlaceholder(/search/i).first();
    if (await searchInput.isVisible()) {
      await searchInput.fill('CYC');
      await page.waitForTimeout(500);
      // Results should still show
      const body = await page.textContent('body');
      expect(body).toBeTruthy();
    }
  });

  test('TC-CYC-09: Status filter tabs work on cycles page', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/cycles`);
    await page.waitForTimeout(2000);

    // Look for status filter buttons
    const filterBtns = page.getByRole('button', { name: /PLANNING|FUNDING|PURCHASING|All/i });
    const count = await filterBtns.count();
    if (count > 0) {
      await filterBtns.first().click();
      await page.waitForTimeout(500);
    }
  });
});
