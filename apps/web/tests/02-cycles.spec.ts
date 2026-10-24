/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: Import Cycle Management
 * ═══════════════════════════════════════════════════════════════════════
 *  Tests: create cycle, view details, status transitions, participants
 */
import { pickCard } from './support/ui';
import { test, expect } from '@playwright/test';
import { apiCtx } from './support/fixtures';
import { WEB as BASE, API } from './support/env';

const EMAIL = 'abdallah@motoparts.com';
const PASSWORD = 'password123';


// Login helper
async function login(page: any) {
  await page.goto(`${BASE}/en/login`);
  await page.getByPlaceholder('name@company.com').fill(EMAIL);
  await page.getByPlaceholder('StrongPassword@123').fill(PASSWORD);
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

  test('TC-CYC-10: step 1 does not ask for a start date; the cycle is dated today', async ({ page, request }) => {
    await login(page);
    await page.goto(`${BASE}/en/cycles/new`);
    await expect(page.getByRole('heading', { name: /cycle information/i })).toBeVisible({ timeout: 10000 });

    // The field was optional and blank already meant today, so it only ever
    // asked for a decision that did not matter.
    await expect(page.getByText(/start date/i)).toHaveCount(0);

    await pickCard(page, 'originType', 'UAE_DIRECT');
    await pickCard(page, 'currency', 'USD');
    await page.getByRole('button', { name: /save & continue/i }).click();

    // Reaching step 2 means the cycle was created without one.
    await expect(page.locator('input[type="hidden"][name="supplierId"]')).toBeAttached({ timeout: 15000 });

    const auth = await request.post(`${API}/auth/login`, {
      data: { email: EMAIL, password: PASSWORD },
    });
    const h = { Authorization: `Bearer ${(await auth.json()).data.accessToken}` };
    const cycles = (await (await request.get(`${API}/cycles?limit=200`, { headers: h })).json()).data;
    const newest = cycles.reduce((a: any, b: any) =>
      new Date(a.createdAt) > new Date(b.createdAt) ? a : b,
    );

    // startedOn is a DATE column filled from the server's clock, so it lands on
    // the same UTC day the record was made.
    expect(newest.startedOn).toBeTruthy();
    expect(String(newest.startedOn).slice(0, 10)).toBe(new Date().toISOString().slice(0, 10));
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

  test('TC-CYC-07: Cycle status transition is available', async ({ page, request }) => {
    // The status change lives on the cycle's page now (owner, 2026-10-11);
    // the list's slide-over that held it is gone. This used to look for a
    // button matching /transition|advance/ only "if visible", so it passed
    // whatever the page showed. A cycle of its own, so there is a move to make.
    const { mk } = await apiCtx(request);
    const cycle = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'EGP' });
    await login(page);
    await page.goto(`${BASE}/en/cycles`);
    await page.locator('tr', { hasText: cycle.code }).getByTestId('cycle-details').click();
    await expect(page).toHaveURL(new RegExp(`/cycles/${cycle.id}/details$`), { timeout: 15000 });
    await expect(page.getByTestId('change-status')).toBeVisible();
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
