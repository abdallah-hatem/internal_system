/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: Audit Logs
 * ═══════════════════════════════════════════════════════════════════════
 *  Tests: view audit logs, filters, entity types, actions
 */
import { test, expect } from '@playwright/test';

const BASE = 'http://localhost:3000';
const API = 'http://localhost:3001/api/v1';
const EMAIL = 'partner.a@motoparts.com';
const PASSWORD = 'password123';

async function login(page: any) {
  await page.goto(`${BASE}/en/login`);
  await page.getByPlaceholder('partner.a@motoparts.com').fill(EMAIL);
  await page.getByPlaceholder('••••••••').fill(PASSWORD);
  await page.getByRole('button', { name: /login/i }).click();
  await expect(page).toHaveURL(/dashboard/, { timeout: 10000 });
}

test.describe('Audit Logs Flow', () => {

  test('TC-AUDIT-01: Audit logs page loads', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/audit-logs`);
    await expect(page.getByRole('heading', { name: /Audit/i })).toBeVisible({ timeout: 10000 });
  });

  test('TC-AUDIT-02: Audit logs table shows data', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/audit-logs`);
    await page.waitForTimeout(2000);
    const body = await page.textContent('body');
    expect(body).toMatch(/Action|Entity|Actor|Date|Time|Timestamp/i);
  });

  test('TC-AUDIT-03: Audit logs show entity types', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/audit-logs`);
    await page.waitForTimeout(2000);
    const body = await page.textContent('body');
    expect(body).toMatch(/CYCLE|PRODUCT|PURCHASE|SALE|PAYMENT|INVENTORY|CUSTOMER|SETTLEMENT/i);
  });

  test('TC-AUDIT-04: Audit logs show action types', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/audit-logs`);
    await page.waitForTimeout(2000);
    const body = await page.textContent('body');
    expect(body).toMatch(/CREATE|UPDATE|DELETE|TRANSITION|CONFIRM|CANCEL|REVERSE|APPROVE|ALLOCATE/i);
  });

  test('TC-AUDIT-05: Audit logs show actor info', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/audit-logs`);
    await page.waitForTimeout(2000);
    const body = await page.textContent('body');
    expect(body).toMatch(/partner|Partner|admin|Admin|motoparts/i);
  });

  test('TC-AUDIT-06: Audit logs are formatted with dates', async ({ page, request }) => {
    // The seed writes through Prisma directly, so a fresh database has no audit
    // entries. Perform one auditable action first rather than depending on
    // whatever happens to be left over from earlier runs.
    const auth = await request.post(`${API}/auth/login`, {
      data: { email: EMAIL, password: PASSWORD },
    });
    const token = (await auth.json()).data.accessToken;
    await request.post(`${API}/providers`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { name: `Audit probe ${Date.now()}` },
    });

    await login(page);
    await page.goto(`${BASE}/en/audit-logs`);
    await page.waitForTimeout(2000);
    const body = await page.textContent('body');
    expect(body).toMatch(/(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4}/);
  });

  test('TC-AUDIT-07: Audit log search/filter works', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/audit-logs`);
    await page.waitForTimeout(2000);
    const searchInput = page.getByPlaceholder(/search|filter/i).first();
    if (await searchInput.isVisible()) {
      await searchInput.fill('CYCLE');
      await page.waitForTimeout(500);
    }
  });

  test('TC-AUDIT-08: Audit log detail is accessible', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/audit-logs`);
    await page.waitForTimeout(2000);

    const viewBtn = page.getByRole('button', { name: /View|Eye|Details/i }).first();
    if (await viewBtn.isVisible()) {
      await viewBtn.click();
      await page.waitForTimeout(1000);
    }
  });
});
