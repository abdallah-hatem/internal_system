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
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { API, EMAIL, PASSWORD, apiCtx, refusedCallers, stockedProduct, today } from './support/fixtures';
import en from '../src/i18n/locales/en.json';

const BASE = process.env.WEB_URL ?? 'http://localhost:3000';

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

async function post(request: APIRequestContext, headers: any, data: unknown, key?: string) {
  const res = await request.post(`${API}/sales/orders`, {
    headers: key ? { ...headers, 'Idempotency-Key': key } : headers,
    data,
  });
  return { status: res.status(), body: await res.json() };
}

async function saleable(request: APIRequestContext, headers: any, productId: string) {
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
    expect(orders.data.filter((o: any) => o.items.some((i: any) => i.productId === product.id))).toHaveLength(0);
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
      expect(list.data.map((c: any) => c.id)).not.toContain(id);
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
  await page.getByPlaceholder('partner.a@motoparts.com').fill(EMAIL);
  await page.getByPlaceholder('••••••••').fill(PASSWORD);
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
    await page.locator('button:has(svg.lucide-menu)').filter({ visible: true }).first().click();
  }
  await link().click();
  await expect(page.getByRole('heading', { name: en.customers.title })).toBeVisible();
  await expect(page.getByText(name, { exact: true })).toHaveCount(0);
});
