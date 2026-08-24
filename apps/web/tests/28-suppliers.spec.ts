/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: Suppliers
 * ═══════════════════════════════════════════════════════════════════════
 *  The suppliers API existed from the start but nothing in the UI reached it:
 *  a supplier could only be picked on a purchase order, never added or edited.
 */
import { test, expect, Page } from '@playwright/test';

const BASE = 'http://localhost:3000';
const API = 'http://localhost:3001/api/v1';
const EMAIL = 'partner.a@motoparts.com';
const PASSWORD = 'password123';

async function login(page: Page) {
  await page.goto(`${BASE}/en/login`);
  await page.getByPlaceholder('partner.a@motoparts.com').fill(EMAIL);
  await page.getByPlaceholder('••••••••').fill(PASSWORD);
  await page.getByRole('button', { name: /login/i }).click();
  await expect(page).toHaveURL(/dashboard/, { timeout: 10000 });
}

async function token(request: any) {
  const auth = await request.post(`${API}/auth/login`, {
    data: { email: EMAIL, password: PASSWORD },
  });
  return (await auth.json()).data.accessToken;
}

test.describe('Suppliers', () => {
  test('TC-SUP-UI-01: the sidebar reaches the page and it lists the seeded suppliers', async ({ page }) => {
    await login(page);
    await page.getByRole('link', { name: /suppliers/i }).click();
    await expect(page).toHaveURL(/\/en\/suppliers/);
    await expect(page.getByRole('heading', { name: 'Suppliers' })).toBeVisible();
    // The desktop table and the mobile card both render the name; the mobile
    // block is hidden by CSS but still in the DOM.
    await expect(page.getByText('Alibaba Supplier - Hangzhou Parts Co.').first()).toBeVisible({ timeout: 10000 });
  });

  test('TC-SUP-UI-02: a supplier can be created, edited and deleted', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/suppliers`);

    // Create
    await page.getByRole('button', { name: /new supplier/i }).click();
    await page.locator('input[name="name"]').fill('Cairo Moto Imports');
    await page.locator('input[name="country"]').fill('Egypt');
    await page.locator('input[name="phone"]').fill('+20-2-5550100');
    await page.getByRole('button', { name: /^create$/i }).click();

    const row = page.locator('tr', { hasText: 'Cairo Moto Imports' });
    await expect(row).toBeVisible({ timeout: 10000 });
    await expect(row).toContainText('Egypt');
    await expect(row).toContainText('+20-2-5550100');

    // Edit — the contact lives in a free-form JSON column, so changing one key
    // must not drop the rest of the record.
    await row.getByTitle('Edit').click();
    await page.locator('input[name="country"]').fill('Egypt (Cairo)');
    await page.getByRole('button', { name: /^save$/i }).click();
    await expect(page.locator('tr', { hasText: 'Cairo Moto Imports' })).toContainText('Egypt (Cairo)', { timeout: 10000 });
    await expect(page.locator('tr', { hasText: 'Cairo Moto Imports' })).toContainText('+20-2-5550100');

    // Delete
    await page.locator('tr', { hasText: 'Cairo Moto Imports' }).getByTitle('Delete').click();
    await page.getByRole('button', { name: /^delete$/i }).last().click();
    await expect(page.locator('tr', { hasText: 'Cairo Moto Imports' })).toHaveCount(0, { timeout: 10000 });
  });

  test('TC-SUP-UI-03: a supplier with purchase orders is not deletable', async ({ page, request }) => {
    const h = { Authorization: `Bearer ${await token(request)}` };
    const suppliers = (await (await request.get(`${API}/suppliers?limit=200`, { headers: h })).json()).data;

    const pos = (await (await request.get(`${API}/purchases?limit=200`, { headers: h })).json()).data;
    const usedId = pos?.[0]?.supplierId;
    test.skip(!usedId, 'no purchase order to anchor on');
    const used = suppliers.find((s: any) => s.id === usedId);
    test.skip(!used, 'purchase order points at a supplier that is not listed');

    // The cost history of stock still on the shelf traces back through the
    // supplier, so the record is kept and the delete refused.
    const res = await request.delete(`${API}/suppliers/${usedId}`, { headers: h });
    expect(res.status()).toBe(400);
    expect(JSON.stringify(await res.json())).toMatch(/purchase order/i);

    await login(page);
    await page.goto(`${BASE}/en/suppliers`);
    await page.locator('tr', { hasText: used.name }).first().getByTitle('Delete').click();
    await expect(page.getByText(/cannot be deleted/i)).toBeVisible();
  });
});
