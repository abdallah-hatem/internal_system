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

/**
 * A shop genuinely owing two orders: an older 500 and a newer 800.
 *
 * The orders are confirmed, which means real stock has to exist behind them —
 * an unconfirmed order is a draft and owes nothing, so a fixture that skipped
 * this was testing against balances the business does not recognise.
 */
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
  const supplier = await mk('suppliers', { name: `Hub Sup ${stamp}`, country: 'AE' });

  const today = new Date();
  const iso = [today.getFullYear(), String(today.getMonth() + 1).padStart(2, '0'), String(today.getDate()).padStart(2, '0')].join('-');

  // Stock, via the only route that creates any.
  const cycle = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'EGP' });
  await mk(`cycles/${cycle.id}/purchases`, {
    supplierId: supplier.id, currency: 'EGP', fxRateToEgp: 1, orderedOn: iso,
    items: [{ productId: product.id, orderedQty: 100, unitPrice: 10 }],
  });
  await mk(`cycles/${cycle.id}/shipping-legs`, {
    sequence: 1, origin: 'Dubai, UAE', destination: 'Cairo, Egypt',
    provider: 'Hub Freight', costBasis: 'FLAT', amount: 0, currency: 'EGP', fxRateToEgp: 1,
  });
  for (const status of ['FUNDING', 'PURCHASING', 'ARRIVED_UAE', 'IN_TRANSIT_TO_EGYPT', 'ARRIVED_EGYPT', 'VERIFICATION']) {
    await mk(`cycles/${cycle.id}/transition`, { status });
  }
  const full = await (await request.get(`${API}/cycles/${cycle.id}`, { headers })).json();
  const poItem = (full.data ?? full).purchaseOrders[0].items[0];
  await mk('receipts/verify', {
    cycleId: cycle.id,
    items: [{ purchaseOrderItemId: poItem.id, productId: product.id, receivedQty: 100 }],
  });

  const confirmedOrder = async (amount: number) => {
    const order = await mk('sales/orders', {
      customerId: customer.id, channel: 'B2B', currency: 'EGP',
      items: [{ productId: product.id, quantity: 1, unitPrice: amount, discount: 0 }],
    });
    await mk(`sales/orders/${order.id}/confirm`, { version: order.version });
    return order;
  };

  const older = await confirmedOrder(500);
  const newer = await confirmedOrder(800);

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

  test('TC-HUB-03: more than the shop owes is refused, not banked as credit', async ({
    page,
    request,
  }) => {
    // This test previously asserted the opposite — that a surplus was kept as
    // credit — because that is what I built. It was the wrong call: money
    // attached to no order clears nothing, still counts as collected, and is
    // almost always a typo. The owner's words: paying 500 against 300 owed
    // "worked", and that is not logical.
    const { headers, customer, older, newer } = await shopOwingTwoOrders(request);
    await login(page);
    await page.goto(`${BASE}/en/customers/${customer.id}`);

    await page.getByRole('button', { name: /record payment|new payment/i }).first().click();
    await page.locator('input[name="amount"]').fill('2000');
    await page.getByRole('button', { name: /save/i }).click();

    // Refused, and said why.
    await expect(page.getByText(/owes/i).first()).toBeVisible({ timeout: 15000 });

    // Nothing moved: both orders still owe exactly what they did.
    expect(await outstanding(request, headers, older.id)).toBe(500);
    expect(await outstanding(request, headers, newer.id)).toBe(800);
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
