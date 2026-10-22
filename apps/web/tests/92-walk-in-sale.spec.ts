/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: a walk-in sale is paid on the spot (W1, server side)
 * ═══════════════════════════════════════════════════════════════════════
 *  BUSINESS_LOGIC §4, DECIDED 2026-10-11: a buyer who is not a shop needs no
 *  customer record. `POST /sales/orders` with `walkIn: true` creates, confirms
 *  and pays the order in full in one step, on one shared walk-in record that
 *  cannot be edited, never owes, and never appears in a customer picker.
 *
 *  These cases drive the API the sale form (W2) and the assistant (W3) will
 *  call; the form's own cases arrive with W2. Stock is built through a cycle
 *  and a verified receipt (CLAUDE.md rule 4). The customers screen is reached
 *  by clicking, not by `page.goto` (rule 2).
 */
import { test, expect, type Page, type APIRequestContext, type Locator } from '@playwright/test';
import { API, EMAIL, PASSWORD, apiCtx, refusedCallers, stockedProduct, today } from './support/fixtures';
import en from '../src/i18n/locales/en.json';
import ar from '../src/i18n/locales/ar.json';
import { WEB as BASE } from './support/env';

const walkIn = (productId: string, quantity: number, extra: Record<string, unknown> = {}) => ({
  walkIn: true,
  currency: 'EGP',
  items: [{ productId, quantity, unitPrice: 450, discount: 0 }],
  ...extra,
});

async function setup(request: APIRequestContext, label: string, qty = 20) {
  const { headers, mk } = await apiCtx(request);
  const stamp = `${Date.now()}`;
  const { product } = await stockedProduct(request, headers, mk, `${label} ${stamp}`, qty);
  return { headers, mk, product };
}

async function post(request: APIRequestContext, headers: Record<string, string>, data: unknown, key?: string) {
  const res = await request.post(`${API}/sales/orders`, {
    headers: key ? { ...headers, 'Idempotency-Key': key } : headers,
    data,
  });
  return { status: res.status(), body: await res.json() };
}

async function saleable(request: APIRequestContext, headers: Record<string, string>, productId: string) {
  const res = await request.get(`${API}/inventory?productId=${productId}&limit=100`, { headers });
  const rows = ((await res.json()).data ?? []) as { batches?: { saleableQty: string }[] }[];
  return rows
    .flatMap((p) => p.batches ?? [])
    .reduce((s, b) => s + Number(b.saleableQty), 0);
}

test.describe('Walk-in sale on the server (§4)', () => {
  test('TC-WI-01: a walk-in sale of 2 at retail → one paid order on the walk-in record, payment allocated, stock down 2, nothing owed', async ({ request }) => {
    const { headers, product } = await setup(request, 'WI01');
    const before = await saleable(request, headers, product.id);

    const { status, body } = await post(request, headers, walkIn(product.id, 2));
    expect(status, JSON.stringify(body)).toBe(201);
    const order = body.data;
    expect(order.channel).toBe('B2C');
    expect(order.status).toBe('PAID');
    expect(Number(order.outstanding)).toBe(0);
    expect(Number(order.total)).toBe(900);
    expect(order.customer.isWalkIn).toBe(true);
    expect(Number(order.payment.amount)).toBe(900);
    expect(order.payment.method).toBe('CASH');
    expect(order.payment.receivedOn.slice(0, 10)).toBe(today());

    const detail = await (await request.get(`${API}/sales/orders/${order.id}`, { headers })).json();
    expect(detail.data.paymentAllocations).toHaveLength(1);
    expect(await saleable(request, headers, product.id)).toBe(before - 2);
  });

  test('TC-WI-02: not enough stock → NOT_ENOUGH_STOCK, and no order or payment is left behind', async ({ request }) => {
    const { headers, product } = await setup(request, 'WI02', 1);
    const payments = async () =>
      (await (await request.get(`${API}/payments?limit=100`, { headers })).json()).data.length;
    const paymentsBefore = await payments();

    const { status, body } = await post(request, headers, walkIn(product.id, 2));
    expect(status).toBe(400);
    expect(body.error.code).toBe('NOT_ENOUGH_STOCK');

    const orders = await (await request.get(`${API}/sales/orders?limit=100`, { headers })).json();
    expect(orders.data.filter((o: ListedOrder) => o.items.some((i) => i.productId === product.id))).toHaveLength(0);
    expect(await payments()).toBe(paymentsBefore);
  });

  test('TC-WI-03: walkIn with a customer → VALIDATION_FAILED; walkIn as a draft → WALK_IN_NOT_DRAFT', async ({ request }) => {
    const { headers, mk, product } = await setup(request, 'WI03');
    const shop = await mk('customers', { displayName: `WI03 Shop ${Date.now()}`, type: 'B2B' });

    const both = await post(request, headers, walkIn(product.id, 1, { customerId: shop.id }));
    expect(both.status).toBe(400);
    expect(both.body.error.code).toBe('VALIDATION_FAILED');

    const draft = await post(request, headers, walkIn(product.id, 1, { confirm: false }));
    expect(draft.status).toBe(400);
    expect(draft.body.error.code).toBe('WALK_IN_NOT_DRAFT');
  });

  test('TC-WI-04: two walk-in sales at once → both succeed on one walk-in record', async ({ request }) => {
    const { headers, product } = await setup(request, 'WI04');
    const [a, b] = await Promise.all([
      post(request, headers, walkIn(product.id, 1)),
      post(request, headers, walkIn(product.id, 1)),
    ]);
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    expect(a.body.data.customerId).toBe(b.body.data.customerId);
  });

  test('TC-WI-05: the walk-in record cannot be edited, nor sold to as an ordinary customer → WALK_IN_RESERVED', async ({ request }) => {
    const { headers, product } = await setup(request, 'WI05');
    const sold = await post(request, headers, walkIn(product.id, 1));
    const id = sold.body.data.customerId;

    const edit = await request.put(`${API}/customers/${id}`, { headers, data: { displayName: 'Ahmed' } });
    expect(edit.status()).toBe(400);
    expect((await edit.json()).error.code).toBe('WALK_IN_RESERVED');

    const named = await post(request, headers, {
      customerId: id, channel: 'B2C', currency: 'EGP',
      items: [{ productId: product.id, quantity: 1, unitPrice: 450 }],
    });
    expect(named.status).toBe(400);
    expect(named.body.error.code).toBe('WALK_IN_RESERVED');
  });

  test('TC-WI-06: the walk-in record owes nothing and is in no customer list; the dashboard counts its sale', async ({ request }) => {
    const { headers, product } = await setup(request, 'WI06');
    const kpis = async () => (await (await request.get(`${API}/analytics/dashboard`, { headers })).json()).data;
    const before = await kpis();

    const sold = await post(request, headers, walkIn(product.id, 3));
    const id = sold.body.data.customerId;

    const page = await (await request.get(`${API}/customers/${id}`, { headers })).json();
    expect(page.data.outstandingBalance).toBe('0.00');
    for (const q of ['', '&search=Walk', '&verification=ALL', '&type=B2C']) {
      const list = await (await request.get(`${API}/customers?limit=100${q}`, { headers })).json();
      expect(list.data.map((c: { id: string }) => c.id)).not.toContain(id);
    }

    const after = await kpis();
    expect(Number(after.totalRevenue) - Number(before.totalRevenue)).toBe(1350);
    expect(after.totalCustomers).toBe(before.totalCustomers);
  });

  test('TC-WI-07: a walk-in return is refunded in money; asking for credit is refused', async ({ request }) => {
    const { headers, product } = await setup(request, 'WI07');
    const sold = await post(request, headers, walkIn(product.id, 2));
    const item = sold.body.data.items[0];

    const credit = await request.post(`${API}/returns`, {
      headers,
      data: { saleOrderId: sold.body.data.id, reason: 'wrong size', refundMethod: 'CREDIT_NOTE', items: [{ saleItemId: item.id, qty: 1 }] },
    });
    expect(credit.status()).toBe(400);
    expect((await credit.json()).error.code).toBe('WALK_IN_REFUND_IN_MONEY');

    const back = await request.post(`${API}/returns`, {
      headers,
      data: { saleOrderId: sold.body.data.id, reason: 'wrong size', items: [{ saleItemId: item.id, qty: 1 }] },
    });
    expect(back.ok(), await back.text()).toBeTruthy();
    expect((await back.json()).data.refundMethod).toBe('CASH');
  });

  test('TC-WI-08: the same Idempotency-Key twice → the same order and one payment', async ({ request }) => {
    const { headers, product } = await setup(request, 'WI08');
    const key = `wi08-${Date.now()}`;
    const [a, b] = await Promise.all([
      post(request, headers, walkIn(product.id, 2), key),
      post(request, headers, walkIn(product.id, 2), key),
    ]);
    const again = await post(request, headers, walkIn(product.id, 2), key);
    expect(a.body.data.id).toBe(b.body.data.id);
    expect(again.body.data.id).toBe(a.body.data.id);
    const detail = await (await request.get(`${API}/sales/orders/${a.body.data.id}`, { headers })).json();
    expect(detail.data.paymentAllocations).toHaveLength(1);
  });

  test('TC-WI-09: a discount larger than the line, or negative, is refused as on any sale', async ({ request }) => {
    const { headers, product } = await setup(request, 'WI09');
    const big = await post(request, headers, { ...walkIn(product.id, 1), items: [{ productId: product.id, quantity: 1, unitPrice: 450, discount: 451 }] });
    expect(big.body.error.code).toBe('DISCOUNT_EXCEEDS_LINE');
    const negative = await post(request, headers, { ...walkIn(product.id, 1), items: [{ productId: product.id, quantity: 1, unitPrice: 450, discount: -5 }] });
    expect(negative.body.error.code).toBe('DISCOUNT_NEGATIVE');
  });

  test('TC-WI-10: an investor or a shop cannot make a walk-in sale', async ({ request }) => {
    const { product } = await setup(request, 'WI10');
    for (const caller of await refusedCallers(request, 'WI10')) {
      const res = await post(request, caller.headers, walkIn(product.id, 1));
      expect(res.status, caller.who).toBe(403);
      expect(res.body.error.code, caller.who).toBe(caller.code);
    }
  });
});

async function login(page: Page) {
  await page.goto(`${BASE}/en/login`);
  await page.getByPlaceholder('name@company.com').fill(EMAIL);
  await page.getByPlaceholder('StrongPassword@123').fill(PASSWORD);
  await page.getByRole('button', { name: en.auth.login, exact: true }).click();
  await expect(page).toHaveURL(/dashboard/, { timeout: 10000 });
}

test('TC-WI-11: the Customers screen does not list the walk-in record', async ({ page, request }) => {
  const { headers, product } = await setup(request, 'WI11');
  const sold = await post(request, headers, walkIn(product.id, 1));
  const name = sold.body.data.customer.displayName as string;

  await login(page);
  const link = () => page.getByRole('link', { name: en.nav.customers, exact: true }).filter({ visible: true }).first();
  if ((await link().count()) === 0) {
    await page.locator('button:has(svg.icon-menu)').filter({ visible: true }).first().click();
  }
  await link().click();
  await expect(page.getByRole('heading', { name: en.customers.title })).toBeVisible();
  await expect(page.getByText(name, { exact: true })).toHaveCount(0);
});

// ─── The sale form (W2) ──────────────────────────────────────────────────
// Reached by logging in and clicking through, never `page.goto` after the
// login page (CLAUDE.md rule 2). With walk-in on, the pickers are: payment
// method, channel, currency, then each line's product.

type Messages = typeof en;
const RETAIL = 450;
const TRADE = 380;

async function loginIn(page: Page, locale: 'en' | 'ar') {
  const m: Messages = locale === 'en' ? en : ar;
  await page.goto(`${BASE}/${locale}/login`);
  await page.getByPlaceholder('name@company.com').fill(EMAIL);
  await page.getByPlaceholder('StrongPassword@123').fill(PASSWORD);
  await page.getByRole('button', { name: m.auth.login, exact: true }).click();
  await expect(page).toHaveURL(/dashboard/, { timeout: 10000 });
}

async function openSales(page: Page, m: Messages = en) {
  const bar = page.getByTestId('phone-bar');
  if (await bar.isVisible()) {
    await bar.getByRole('link', { name: m.nav.short.sales, exact: true }).click();
  } else {
    await page.getByRole('link', { name: m.nav.sales, exact: true }).filter({ visible: true }).first().click();
  }
  await expect(page.getByRole('heading', { name: m.sales.title })).toBeVisible();
}

async function openNewOrder(page: Page, m: Messages = en) {
  await page.getByRole('button', { name: m.sales.create }).first().click();
  const form = page.getByTestId('sale-order-form');
  await expect(form).toBeVisible();
  return form;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
async function choose(page: Page, trigger: Locator, label: string) {
  await trigger.click();
  const search = page.locator('[cmdk-input]').filter({ visible: true });
  if (await search.count()) await search.fill(label);
  await page.getByRole('option', { name: new RegExp(escapeRe(label)) }).first().click();
}
const combo = (form: Locator, n: number) => form.getByRole('combobox').nth(n);
const lineOf = (form: Locator, n: number) => form.getByTestId('sale-line').nth(n);
const inputOf = (row: Locator, name: string) => row.locator(`[data-field="${name}"]:not([type="hidden"])`);

/** A product with stock and both list prices, and a shop to compare against. */
async function pricedStock(request: APIRequestContext, label: string, qty = 20) {
  const { headers, mk, product } = await setup(request, label, qty);
  for (const [channel, amount] of [['B2B', TRADE], ['B2C', RETAIL]] as const) {
    const res = await request.post(`${API}/products/${product.id}/prices`, {
      headers,
      data: { channel, currency: 'EGP', amount },
    });
    expect(res.ok(), await res.text()).toBeTruthy();
  }
  const shop = await mk('customers', { displayName: `${label} Shop ${Date.now()}`, type: 'B2B' });
  return { headers, mk, product, shop };
}

interface ListedOrder {
  id: string;
  orderNo: string;
  status: string;
  total: string;
  outstanding: string;
  items: { productId: string }[];
}

async function ordersOfProduct(request: APIRequestContext, headers: Record<string, string>, productId: string) {
  const body = await (await request.get(`${API}/sales/orders?limit=100`, { headers })).json();
  return (body.data as ListedOrder[]).filter((o) => o.items.some((i) => i.productId === productId));
}

test.describe('Walk-in on the sale form (§4, W2)', () => {
  test('TC-WI-12: the switch hides the customer and its +, shows the method on Cash, fixes B2C and fills the retail price', async ({ page, request }) => {
    const { shop, product } = await pricedStock(request, 'WI12');
    await loginIn(page, 'en');
    await openSales(page);
    const form = await openNewOrder(page);
    await choose(page, combo(form, 0), shop.displayName);
    await choose(page, combo(form, 3), product.name);
    await expect(inputOf(lineOf(form, 0), 'unitPrice')).toHaveValue(String(TRADE));

    await form.getByRole('switch', { name: en.sales.walkIn }).click();
    await expect(form.locator('[data-quick-create="customer"]')).toHaveCount(0);
    await expect(form.getByText(shop.displayName)).toHaveCount(0);
    await expect(combo(form, 0)).toContainText(en.codes.paymentMethod.CASH);
    await expect(combo(form, 1)).toContainText(en.sales.b2c);
    await expect(combo(form, 1)).toBeDisabled();
    await expect(inputOf(lineOf(form, 0), 'unitPrice')).toHaveValue(String(RETAIL));
    await expect(form.getByRole('button', { name: en.sales.saveDraft })).toHaveCount(0);
    await expect(form.getByRole('button', { name: en.sales.createAndConfirm })).toHaveCount(0);
    await expect(form.getByRole('button', { name: en.sales.sellAndTakePayment })).toBeVisible();
    await expect(form.getByTestId('walk-in-paid')).toContainText(en.codes.paymentMethod.CASH);
  });

  test('TC-WI-13: a typed price survives the switch going on and off; off brings the shop, B2B and the draft button back', async ({ page, request }) => {
    const { shop, product } = await pricedStock(request, 'WI13');
    await loginIn(page, 'en');
    await openSales(page);
    const form = await openNewOrder(page);
    await choose(page, combo(form, 0), shop.displayName);
    await choose(page, combo(form, 3), product.name);
    await inputOf(lineOf(form, 0), 'unitPrice').fill('400');

    const sw = form.getByRole('switch', { name: en.sales.walkIn });
    await sw.click();
    await expect(inputOf(lineOf(form, 0), 'unitPrice')).toHaveValue('400');
    await sw.click();
    await expect(inputOf(lineOf(form, 0), 'unitPrice')).toHaveValue('400');
    await expect(combo(form, 0)).toContainText(shop.displayName);
    await expect(combo(form, 1)).toContainText(en.sales.b2b);
    await expect(form.getByRole('button', { name: en.sales.saveDraft })).toBeVisible();
  });

  test('TC-WI-14: Sell & take payment → one request, a PAID walk-in order by the chosen method; the list says Walk-in and owes nothing', async ({ page, request }) => {
    const { headers, product } = await pricedStock(request, 'WI14');
    await loginIn(page, 'en');
    await openSales(page);
    const form = await openNewOrder(page);
    await form.getByRole('switch', { name: en.sales.walkIn }).click();
    await choose(page, combo(form, 0), en.codes.paymentMethod.MOBILE_WALLET);
    await choose(page, combo(form, 3), product.name);
    await inputOf(lineOf(form, 0), 'quantity').fill('2');

    const posts: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && /\/sales\/orders/.test(r.url())) posts.push(r.postData() ?? '');
    });
    // A double click: one request (U1's guard, and the idempotency key behind it).
    await form.getByRole('button', { name: en.sales.sellAndTakePayment }).dblclick();
    await expect(form).toBeHidden();
    await expect(page.getByText(en.sales.walkInSold)).toBeVisible();
    expect(posts).toHaveLength(1);
    const body = JSON.parse(posts[0]);
    expect(body).toMatchObject({ walkIn: true, confirm: true, payment: { method: 'MOBILE_WALLET' } });
    expect(body.customerId).toBeUndefined();

    const orders = await ordersOfProduct(request, headers, product.id);
    expect(orders).toHaveLength(1);
    expect(orders[0].status).toBe('PAID');
    expect(Number(orders[0].total)).toBe(2 * RETAIL);
    expect(Number(orders[0].outstanding)).toBe(0);
    const detail = (await (await request.get(`${API}/sales/orders/${orders[0].id}`, { headers })).json()).data;
    expect(detail.paymentAllocations[0].payment.method).toBe('MOBILE_WALLET');

    // The list, reached by the click that closed the form: Walk-in, no balance.
    await page.getByPlaceholder(en.sales.search).fill(orders[0].orderNo);
    const row = page.getByTestId('sale-row').filter({ hasText: orders[0].orderNo });
    await expect(row.getByTestId('walk-in-customer')).toHaveText(en.sales.walkInCustomer);
    await expect(row.getByTestId('outstanding')).toContainText(en.sales.walkInNoBalance);
    // And the detail says the same.
    await row.locator('td').nth(6).click();
    const dialog = page.getByRole('heading', { name: orders[0].orderNo }).locator('xpath=ancestor::div[contains(@class,"rounded-2xl")]');
    await expect(dialog.getByText(en.sales.walkInCustomer, { exact: true })).toBeVisible();
    await expect(dialog.getByTestId('outstanding')).toContainText(en.sales.walkInNoBalance);
    await expect(dialog.getByTestId('order-record-payment')).toHaveCount(0);
  });

  test('TC-WI-15: more than is in stock → refused in words, nothing written, the form keeps the switch, method and lines', async ({ page, request }) => {
    const { headers, product } = await pricedStock(request, 'WI15', 3);
    await loginIn(page, 'en');
    await openSales(page);
    const form = await openNewOrder(page);
    await form.getByRole('switch', { name: en.sales.walkIn }).click();
    await choose(page, combo(form, 0), en.codes.paymentMethod.CHEQUE);
    await choose(page, combo(form, 3), product.name);
    await inputOf(lineOf(form, 0), 'quantity').fill('5');
    await form.getByRole('button', { name: en.sales.sellAndTakePayment }).click();

    const alert = form.getByRole('alert');
    await expect(alert).toBeVisible();
    await expect(alert).not.toContainText('unexpected');
    await expect(form.getByRole('switch', { name: en.sales.walkIn })).toHaveAttribute('aria-checked', 'true');
    await expect(combo(form, 0)).toContainText(en.codes.paymentMethod.CHEQUE);
    await expect(inputOf(lineOf(form, 0), 'quantity')).toHaveValue('5');
    await expect(inputOf(lineOf(form, 0), 'unitPrice')).toHaveValue(String(RETAIL));
    expect(await ordersOfProduct(request, headers, product.id)).toHaveLength(0);
  });

  test('TC-WI-16: a walk-in return offers money only, never credit', async ({ page, request }) => {
    const { headers, product } = await pricedStock(request, 'WI16');
    const sold = await post(request, headers, walkIn(product.id, 2));
    await loginIn(page, 'en');
    await openSales(page);
    await page.getByPlaceholder(en.sales.search).fill(sold.body.data.orderNo);
    await page.getByTestId('sale-row').filter({ hasText: sold.body.data.orderNo }).locator('td').nth(6).click();
    await page.getByRole('button', { name: en.sales.recordReturn }).click();
    const refund = page.getByRole('combobox').filter({ hasText: en.sales.cashRefund });
    await expect(refund).toBeVisible();
    await refund.click();
    await expect(page.getByRole('option', { name: en.sales.creditNote })).toHaveCount(0);
  });

  test('TC-WI-17: at 390px in Arabic the switch row fits, the sale button is the only primary, and nothing scrolls sideways', async ({ page, request }) => {
    const { product } = await pricedStock(request, 'WI17');
    await page.setViewportSize({ width: 390, height: 844 });
    await loginIn(page, 'ar');
    await openSales(page, ar);
    const form = await openNewOrder(page, ar);
    const sw = form.getByRole('switch', { name: ar.sales.walkIn });
    await sw.click();
    await expect(sw).toHaveAttribute('aria-checked', 'true');
    await choose(page, combo(form, 3), product.name);

    // The switch sits on the label row, at the row's end — the left in Arabic.
    const swBox = (await sw.boundingBox())!;
    const methodBox = (await combo(form, 0).boundingBox())!;
    expect(swBox.y + swBox.height).toBeLessThanOrEqual(methodBox.y + 1);
    expect(swBox.x).toBeLessThan(methodBox.x + methodBox.width / 2);
    await expect(form.getByRole('button', { name: ar.sales.sellAndTakePayment })).toBeVisible();
    await expect(form.getByRole('button', { name: ar.sales.saveDraft })).toHaveCount(0);
    await expect(form.getByTestId('walk-in-paid')).toContainText(ar.codes.paymentMethod.CASH);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
