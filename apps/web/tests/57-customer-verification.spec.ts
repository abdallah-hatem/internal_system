/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: Vetting a shop that signed itself up
 * ═══════════════════════════════════════════════════════════════════════
 *  Self-signup writes an UNVERIFIED customer, and the list endpoint hides
 *  those unless asked. The panel never asked, and `update` did not accept the
 *  column — so a shop could sign up, could be refused by every service that
 *  moves money, and could never be let through. It was invisible and it was
 *  permanent.
 */
import { test, expect, Page, APIRequestContext } from '@playwright/test';
import { API, EMAIL, PASSWORD } from './support/fixtures';

const BASE = 'http://localhost:3000';

async function officeHeaders(request: APIRequestContext) {
  const res = await request.post(`${API}/auth/login`, {
    data: { email: EMAIL, password: PASSWORD },
  });
  return { Authorization: `Bearer ${(await res.json()).data.accessToken}` };
}

/** A fresh shop signing itself up, as the storefront does it. */
async function signUpShop(request: APIRequestContext) {
  const shopName = `Nasr City Motors ${Date.now().toString().slice(-5)}`;
  const email = `${shopName.toLowerCase().replace(/[^a-z0-9]+/g, '.')}@example.com`;
  const res = await request.post(`${API}/auth/portal/signup`, {
    data: { email, password: 'password123', shopName, phone: '+20-2-5550199' },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  return { shopName, email };
}

async function login(page: Page) {
  await page.goto(`${BASE}/en/login`);
  await page.getByPlaceholder('partner.a@motoparts.com').fill(EMAIL);
  await page.getByPlaceholder('••••••••').fill(PASSWORD);
  await page.getByRole('button', { name: /login/i }).click();
  await expect(page).toHaveURL(/dashboard/, { timeout: 10000 });
}

test.describe('Customer verification', () => {
  test('TC-VER-01: a self-signup is hidden by default and found under Awaiting review', async ({ page, request }) => {
    const h = await officeHeaders(request);
    const { shopName } = await signUpShop(request);

    // The default list is the office's real customers only.
    const hidden = (await (await request.get(`${API}/customers?limit=200`, { headers: h })).json()).data;
    expect(hidden.some((c: any) => c.displayName === shopName)).toBe(false);

    const shown = (await (
      await request.get(`${API}/customers?limit=200&verification=UNVERIFIED`, { headers: h })
    ).json()).data;
    expect(shown.some((c: any) => c.displayName === shopName)).toBe(true);

    // …and the panel can now reach that list, which was the missing half.
    await login(page);
    await page.goto(`${BASE}/en/customers`);
    await expect(page.getByText(shopName).first()).toHaveCount(0);

    await page.locator('#verification-filter').click();
    await page.getByRole('listbox').getByRole('option').filter({ hasText: /awaiting review/i }).first().click();
    await expect(page.getByText(shopName).first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator('tr', { hasText: shopName }).getByText(/awaiting review/i)).toBeVisible();
  });

  test('TC-VER-02: verifying from the panel moves the shop into the real list', async ({ page, request }) => {
    const h = await officeHeaders(request);
    const { shopName } = await signUpShop(request);

    await login(page);
    await page.goto(`${BASE}/en/customers`);
    await page.locator('#verification-filter').click();
    await page.getByRole('listbox').getByRole('option').filter({ hasText: /awaiting review/i }).first().click();

    const row = page.locator('tr', { hasText: shopName });
    await expect(row).toBeVisible({ timeout: 10000 });
    await row.getByTitle('Verify').click();
    await page.getByRole('button', { name: /^verify$/i }).last().click();

    // The badge is the thing a person reads; it has to go.
    await expect(page.getByText(/customer verified/i).first()).toBeVisible({ timeout: 10000 });

    const verified = (await (await request.get(`${API}/customers?limit=200`, { headers: h })).json()).data;
    const found = verified.find((c: any) => c.displayName === shopName);
    expect(found, 'a verified shop belongs in the unfiltered list').toBeTruthy();
    expect(found.verificationStatus).toBe('VERIFIED');
  });

  test('TC-VER-03: verifying twice is a double-click, not an error', async ({ request }) => {
    const h = await officeHeaders(request);
    const { shopName } = await signUpShop(request);
    const list = (await (
      await request.get(`${API}/customers?limit=200&verification=UNVERIFIED`, { headers: h })
    ).json()).data;
    const shop = list.find((c: any) => c.displayName === shopName);

    const first = await request.post(`${API}/customers/${shop.id}/verify`, { headers: h });
    expect(first.ok()).toBeTruthy();
    const second = await request.post(`${API}/customers/${shop.id}/verify`, { headers: h });
    expect(second.ok(), 'a second verify is a no-op, not a refusal').toBeTruthy();
    expect((await second.json()).data.verificationStatus).toBe('VERIFIED');
  });

  test('TC-VER-04: a shop cannot verify itself', async ({ request }) => {
    const h = await officeHeaders(request);
    const { shopName, email } = await signUpShop(request);
    const list = (await (
      await request.get(`${API}/customers?limit=200&verification=UNVERIFIED`, { headers: h })
    ).json()).data;
    const shop = list.find((c: any) => c.displayName === shopName);

    const portal = await request.post(`${API}/auth/portal/login`, {
      data: { email, password: 'password123' },
    });
    const portalToken = (await portal.json()).data.accessToken;

    // Vetting is the office's decision. A portal token reaching this would let
    // a stranger promote itself into the table balances hang off.
    const res = await request.post(`${API}/customers/${shop.id}/verify`, {
      headers: { Authorization: `Bearer ${portalToken}` },
    });
    expect(res.ok()).toBe(false);
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });
});
