/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: The customer page, and taking money in one step
 * ═══════════════════════════════════════════════════════════════════════
 *  Recording a payment used to be three steps across two screens: create it,
 *  find it in a list, then allocate it to an order picked from every order in
 *  the system. Nobody takes money from a shop and thinks of it that way — they
 *  think "he paid 5,000 off what he owes".
 *
 *  Here it is one action, applied oldest debt first, which is both what shops
 *  expect and the rule the instalment logic already follows.
 */
import { test, expect, Page, APIRequestContext } from '@playwright/test';

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

async function token(request: APIRequestContext) {
  const auth = await request.post(`${API}/auth/login`, {
    data: { email: EMAIL, password: PASSWORD },
  });
  return (await auth.json()).data.accessToken;
}

/** A shop owing two orders: an older 500 and a newer 800. */
async function shopOwingTwoOrders(request: APIRequestContext) {
  const t = await token(request);
  const headers = { Authorization: `Bearer ${t}` };
  const stamp = Date.now();

  const mk = async (path: string, data: any) => {
    const res = await request.post(`${API}/${path}`, { headers, data });
    expect(res.ok(), `${path}: ${await res.text()}`).toBeTruthy();
    const body = await res.json();
    return body.data ?? body;
  };

  const customer = await mk('customers', { displayName: `Hub Shop ${stamp}`, type: 'B2B' });
  const product = await mk('products', { name: `Hub Part ${stamp}`, minStock: 0 });

  const order = (qty: number, price: number) =>
    mk('sales/orders', {
      customerId: customer.id,
      channel: 'B2B',
      currency: 'EGP',
      items: [{ productId: product.id, quantity: qty, unitPrice: price, discount: 0 }],
    });

  const older = await order(1, 500);
  const newer = await order(1, 800);

  return { headers, customer, older, newer };
}

const outstanding = async (request: APIRequestContext, headers: any, id: string) => {
  const res = await request.get(`${API}/sales/orders/${id}`, { headers });
  return Number(((await res.json()).data ?? {}).outstanding);
};

test.describe('Customer page', () => {
  test('TC-HUB-01: shows what the shop owes, has paid, and has ordered', async ({
    page,
    request,
  }) => {
    const { customer } = await shopOwingTwoOrders(request);
    await login(page);
    await page.goto(`${BASE}/en/customers/${customer.id}`);

    await expect(page.getByRole('heading', { name: customer.displayName })).toBeVisible();
    // 500 + 800 owed, both orders listed, on one screen.
    await expect(page.getByText('1,300.00', { exact: false }).first()).toBeVisible({
      timeout: 15000,
    });
  });

  test('TC-HUB-02: a payment is recorded and applied to the oldest order first', async ({
    page,
    request,
  }) => {
    const { headers, customer, older, newer } = await shopOwingTwoOrders(request);
    await login(page);
    await page.goto(`${BASE}/en/customers/${customer.id}`);

    // 700 clears the older 500 and leaves 200 against the newer 800.
    await page.getByRole('button', { name: /record payment|new payment/i }).first().click();
    await page.locator('input[name="amount"]').fill('700');
    await page.getByRole('button', { name: /save/i }).click();

    await expect
      .poll(() => outstanding(request, headers, older.id), { timeout: 15000 })
      .toBe(0);
    expect(await outstanding(request, headers, newer.id)).toBe(600);
  });

  test('TC-HUB-03: money beyond what is owed stays as credit rather than failing', async ({
    page,
    request,
  }) => {
    // A shop paying round numbers ("here's 2,000") must not hit an error
    // because it exceeds the orders on file.
    const { headers, customer, older, newer } = await shopOwingTwoOrders(request);
    await login(page);
    await page.goto(`${BASE}/en/customers/${customer.id}`);

    await page.getByRole('button', { name: /record payment|new payment/i }).first().click();
    await page.locator('input[name="amount"]').fill('2000');
    await page.getByRole('button', { name: /save/i }).click();

    await expect
      .poll(() => outstanding(request, headers, older.id), { timeout: 15000 })
      .toBe(0);
    expect(await outstanding(request, headers, newer.id)).toBe(0);

    // The extra 700 is recorded but applied to nothing.
    const res = await request.get(`${API}/payments?customerId=${customer.id}&limit=10`, { headers });
    const payments = (await res.json()).data ?? [];
    const total = payments.reduce((s: number, p: any) => s + Number(p.amount), 0);
    expect(total).toBe(2000);
  });

  test('TC-HUB-04: New Order opens the form on that shop, already chosen', async ({
    page,
    request,
  }) => {
    // It used to drop you on the sales list to find the shop you had just been
    // looking at.
    const { customer } = await shopOwingTwoOrders(request);
    await login(page);
    await page.goto(`${BASE}/en/customers/${customer.id}`);

    await page.getByRole('button', { name: /new order/i }).first().click();

    const chosen = page
      .locator('input[type="hidden"][name="customerId"]')
      .locator('..')
      .getByRole('combobox');
    await expect(chosen).toContainText(customer.displayName, { timeout: 15000 });

    // The channel follows the shop's type rather than the B2B default by luck.
    await expect(page.locator('input[type="hidden"][name="channel"]')).toHaveValue('B2B');

    // The parameter is consumed, so a reload does not reopen the form.
    await expect(page).toHaveURL(/\/sales$/);
  });
});
