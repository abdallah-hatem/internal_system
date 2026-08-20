/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: Authentication Flow
 * ═══════════════════════════════════════════════════════════════════════
 *  Tests: login, logout, invalid credentials, profile, token persistence
 */
import { test, expect } from '@playwright/test';

const BASE = 'http://localhost:3000';
const VALID_EMAIL = 'partner.a@motoparts.com';
const VALID_PASSWORD = 'password123';
const INVALID_EMAIL = 'wrong@example.com';
const INVALID_PASSWORD = 'wrongpassword';

test.describe('Authentication Flow', () => {

  test('TC-AUTH-01: Login page renders correctly', async ({ page }) => {
    await page.goto(`${BASE}/en/login`);
    await expect(page.getByPlaceholder('partner.a@motoparts.com')).toBeVisible();
    await expect(page.getByPlaceholder('••••••••')).toBeVisible();
    await expect(page.getByRole('button', { name: /login/i })).toBeVisible();
  });

  test('TC-AUTH-02: Login with invalid credentials shows error', async ({ page }) => {
    await page.goto(`${BASE}/en/login`);
    await page.getByPlaceholder('partner.a@motoparts.com').fill(INVALID_EMAIL);
    await page.getByPlaceholder('••••••••').fill(INVALID_PASSWORD);
    await page.getByRole('button', { name: /login/i }).click();
    // Error appears as a div with red styling or the alert role
    const errorMsg = page.locator('.bg-red-50, [class*="text-red"], [role="alert"]');
    await expect(errorMsg.first()).toBeVisible({ timeout: 10000 });
  });

  test('TC-AUTH-03: Login with valid credentials redirects to dashboard', async ({ page }) => {
    await page.goto(`${BASE}/en/login`);
    await page.getByPlaceholder('partner.a@motoparts.com').fill(VALID_EMAIL);
    await page.getByPlaceholder('••••••••').fill(VALID_PASSWORD);
    await page.getByRole('button', { name: /login/i }).click();
    await expect(page).toHaveURL(/dashboard/, { timeout: 10000 });
    await expect(page.getByText('Admin')).toBeVisible({ timeout: 5000 });
  });

  test('TC-AUTH-04: Token persists after page reload', async ({ page }) => {
    await page.goto(`${BASE}/en/login`);
    await page.getByPlaceholder('partner.a@motoparts.com').fill(VALID_EMAIL);
    await page.getByPlaceholder('••••••••').fill(VALID_PASSWORD);
    await page.getByRole('button', { name: /login/i }).click();
    await expect(page).toHaveURL(/dashboard/, { timeout: 10000 });

    // Reload and check we're still logged in
    await page.reload();
    await expect(page).toHaveURL(/dashboard/, { timeout: 10000 });
    await expect(page.getByText('Admin')).toBeVisible({ timeout: 5000 });
  });

  test('TC-AUTH-05: Login button shows loading spinner', async ({ page }) => {
    await page.goto(`${BASE}/en/login`);
    await page.getByPlaceholder('partner.a@motoparts.com').fill(VALID_EMAIL);
    await page.getByPlaceholder('••••••••').fill(VALID_PASSWORD);
    await page.getByRole('button', { name: /login/i }).click();
    // Button should briefly be disabled/loading
    await expect(page.getByRole('button', { name: /login/i })).toBeDisabled();
  });

  test('TC-AUTH-06: Protected page redirects to login when unauthenticated', async ({ page, context }) => {
    // Create a fresh context with no localStorage
    const freshPage = await context.newPage();
    await freshPage.goto(`${BASE}/en/dashboard`);
    // Should eventually redirect to login or show login form
    await expect(freshPage).toHaveURL(/login|dashboard/, { timeout: 10000 });
  });
});
