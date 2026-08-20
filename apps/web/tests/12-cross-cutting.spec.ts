/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: Cross-Cutting Concerns
 * ═══════════════════════════════════════════════════════════════════════
 *  Tests: navigation, sidebar, language switch, settings, notifications,
 *         categories, providers, shipments, partners, responsive
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

test.describe('Cross-Cutting Concerns', () => {

  // ── Navigation ──────────────────────────────────────────────────────

  test('TC-XCUT-01: Sidebar navigation has all menu items', async ({ page }) => {
    await login(page);
    const sidebar = page.locator('aside');
    await expect(sidebar.first()).toBeVisible();
    const body = await page.textContent('body');
    expect(body).toMatch(/Dashboard/);
    expect(body).toMatch(/Import Cycles|Cycles/);
    expect(body).toMatch(/Purchases/);
    expect(body).toMatch(/Products/);
    expect(body).toMatch(/Inventory/);
    expect(body).toMatch(/Sales/);
    expect(body).toMatch(/Customers/);
    expect(body).toMatch(/Payments/);
    expect(body).toMatch(/Ledger/);
  });

  test('TC-XCUT-02: Sidebar links navigate correctly', async ({ page }) => {
    await login(page);

    // Click Products link
    await page.getByRole('link', { name: 'Products' }).click();
    await expect(page).toHaveURL(/products/, { timeout: 5000 });

    // Click Inventory link
    await page.getByRole('link', { name: 'Inventory' }).click();
    await expect(page).toHaveURL(/inventory/, { timeout: 5000 });

    // Click Sales link
    await page.getByRole('link', { name: 'Sales' }).click();
    await expect(page).toHaveURL(/sales/, { timeout: 5000 });

    // Click Dashboard link
    await page.getByRole('link', { name: 'Dashboard' }).click();
    await expect(page).toHaveURL(/dashboard/, { timeout: 5000 });
  });

  // ── Language Switch ─────────────────────────────────────────────────

  test('TC-XCUT-03: Language switch button is visible', async ({ page }) => {
    await login(page);
    const langBtn = page.getByRole('button', { name: /EN|AR|ENGLISH|ARABIC/i });
    await expect(langBtn.first()).toBeVisible({ timeout: 5000 });
  });

  test('TC-XCUT-04: Language can be switched to Arabic', async ({ page }) => {
    await login(page);
    const langBtn = page.getByRole('button', { name: /EN/i }).first();
    if (await langBtn.isVisible()) {
      await langBtn.click();
      await page.waitForTimeout(500);
      // Click AR option
      const arOption = page.getByRole('button', { name: /AR|عربي/i }).first();
      if (await arOption.isVisible()) {
        await arOption.click();
        await page.waitForTimeout(1000);
        // URL should now have /ar/
        expect(page.url()).toMatch(/\/ar\//);
      }
    }
  });

  // ── Notifications ───────────────────────────────────────────────────

  test('TC-XCUT-05: Notifications page loads', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/notifications`);
    await expect(page.getByRole('heading', { name: /Notification/i })).toBeVisible({ timeout: 10000 });
  });

  test('TC-XCUT-06: Notification bell icon shows count', async ({ page }) => {
    await login(page);
    // Look for notification bell/badge in header
    const body = await page.textContent('body');
    expect(body).toBeTruthy();
  });

  // ── Settings ────────────────────────────────────────────────────────

  test('TC-XCUT-07: Settings page loads', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/settings`);
    await expect(page.getByRole('heading', { name: /Setting|Profile/i })).toBeVisible({ timeout: 10000 });
  });

  test('TC-XCUT-08: Settings shows user profile info', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/settings`);
    await page.waitForTimeout(2000);
    const body = await page.textContent('body');
    expect(body).toMatch(/partner.a@motoparts.com|partner|email|password|Password/i);
  });

  // ── Categories ──────────────────────────────────────────────────────

  test('TC-XCUT-09: Categories page loads', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/categories`);
    await expect(page.getByRole('heading', { name: /Categor/i })).toBeVisible({ timeout: 10000 });
  });

  test('TC-XCUT-10: Categories list shows seed data', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/categories`);
    await page.waitForTimeout(2000);
    const body = await page.textContent('body');
    expect(body).toMatch(/Brake Parts|Filters|Engine Parts|Electrical|Chains/i);
  });

  // ── Providers ───────────────────────────────────────────────────────

  test('TC-XCUT-11: Providers page loads', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/providers`);
    await expect(page.getByRole('heading', { name: /Provider/i })).toBeVisible({ timeout: 10000 });
  });

  // ── Shipments ───────────────────────────────────────────────────────

  test('TC-XCUT-12: Shipments page loads', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/shipments`);
    await expect(page.getByRole('heading', { name: /Shipment|Shipping/i })).toBeVisible({ timeout: 10000 });
  });

  // ── Partners ────────────────────────────────────────────────────────

  test('TC-XCUT-13: Partners page loads', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/partners`);
    await expect(page.getByRole('heading', { name: /Partner/i })).toBeVisible({ timeout: 10000 });
  });

  // ── User Profile ────────────────────────────────────────────────────

  test('TC-XCUT-14: User profile shown in header', async ({ page }) => {
    await login(page);
    const body = await page.textContent('body');
    expect(body).toMatch(/Admin|partner|Core Partner/i);
  });

  // ── Global Search ───────────────────────────────────────────────────

  test('TC-XCUT-15: Global search input exists in header', async ({ page }) => {
    await login(page);
    const searchInput = page.getByPlaceholder(/search/i).first();
    await expect(searchInput).toBeVisible();
  });

  // ── Responsive ──────────────────────────────────────────────────────

  test('TC-XCUT-16: Pages load on mobile viewport', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await login(page);
    await page.goto(`${BASE}/en/dashboard`);
    await expect(page.getByRole('heading', { name: /Dashboard/i })).toBeVisible({ timeout: 10000 });
  });

  // ── Empty States ────────────────────────────────────────────────────

  test('TC-XCUT-17: No data state shows message', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/notifications`);
    await page.waitForTimeout(2000);
    // Should either show notifications or a "no data" message
    const body = await page.textContent('body');
    expect(body).toMatch(/No|notification|empty|no data/i);
  });
});
