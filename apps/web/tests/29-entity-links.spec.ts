/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: Customer and product names link to their own pages
 * ═══════════════════════════════════════════════════════════════════════
 *  Both detail pages existed, but the only way into either was an eye icon in
 *  the directory's action column. A customer on a payment, or a product on a
 *  sale, was a dead end.
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

/** The first name-link on the page that points at the given section. */
function firstLinkTo(page: Page, section: 'customers' | 'products') {
  return page.locator(`a[href*="/${section}/"]`).first();
}

test.describe('Entity links', () => {
  test('TC-LINK-01: a customer on the sales table opens the customer page', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/sales`);

    const link = firstLinkTo(page, 'customers');
    await expect(link).toBeVisible({ timeout: 15000 });
    const name = (await link.textContent())?.trim();

    await link.click();
    await expect(page).toHaveURL(/\/en\/customers\/[0-9a-f-]{36}/, { timeout: 15000 });
    await expect(page.getByText(name!).first()).toBeVisible();
  });

  test('TC-LINK-02: a customer on the payments table opens the customer page', async ({ page, request }) => {
    // The seed creates no payments, so the table would be empty and the test
    // would pass by never finding a row to check.
    const h = { Authorization: `Bearer ${await token(request)}` };
    const customers = (await (await request.get(`${API}/customers?limit=5`, { headers: h })).json()).data;
    test.skip(!customers?.length, 'no customer to record a payment against');
    await request.post(`${API}/payments`, {
      headers: h,
      data: {
        customerId: customers[0].id,
        amount: 250,
        currency: 'EGP',
        method: 'CASH',
        receivedOn: new Date().toISOString().slice(0, 10),
      },
    });

    await login(page);
    await page.goto(`${BASE}/en/payments`);

    const link = firstLinkTo(page, 'customers');
    await expect(link).toBeVisible({ timeout: 15000 });
    await link.click();
    await expect(page).toHaveURL(/\/en\/customers\/[0-9a-f-]{36}/, { timeout: 15000 });
  });

  test('TC-LINK-03: a product on the inventory table opens the product page', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/inventory`);

    const link = firstLinkTo(page, 'products');
    await expect(link).toBeVisible({ timeout: 15000 });
    const name = (await link.textContent())?.trim();

    // The inventory row expands on click; the link must navigate instead of
    // toggling the row open underneath it.
    await link.click();
    await expect(page).toHaveURL(/\/en\/products\/[0-9a-f-]{36}/, { timeout: 15000 });
    await expect(page.getByText(name!).first()).toBeVisible();
  });

  test('TC-LINK-04: the directories link their own names too', async ({ page }) => {
    await login(page);

    await page.goto(`${BASE}/en/customers`);
    await expect(firstLinkTo(page, 'customers')).toBeVisible({ timeout: 15000 });

    await page.goto(`${BASE}/en/products`);
    await expect(firstLinkTo(page, 'products')).toBeVisible({ timeout: 15000 });
  });
});
