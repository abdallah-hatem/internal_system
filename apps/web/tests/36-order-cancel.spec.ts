/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: Cancelling an order
 * ═══════════════════════════════════════════════════════════════════════
 *  Cancelling put the stock back and marked the order dead, and did nothing
 *  about the money. A 400 payment against a 1,000 order survived the cancel
 *  still allocated to it: the order dropped out of what the shop owed, the
 *  payment stayed spent on a dead order, and the 400 could not be used
 *  anywhere else. The UI even offered Cancel specifically on partially paid
 *  orders — the one state where money had certainly arrived.
 *
 *  Cancelling is for an order that never happened. Money coming back is a
 *  refund, and a refund is a return, where goods, cost and cash move together.
 */
import { test, expect, Page, APIRequestContext } from '@playwright/test';
import { apiCtx, stockedProduct, owedOrder, outstandingOf, API } from './support/fixtures';

const BASE = 'http://localhost:3000';
const EMAIL = 'partner.a@motoparts.com';
const PASSWORD = 'password123';

async function login(page: Page) {
  await page.goto(`${BASE}/en/login`);
  await page.getByPlaceholder('partner.a@motoparts.com').fill(EMAIL);
  await page.getByPlaceholder('••••••••').fill(PASSWORD);
  await page.getByRole('button', { name: /login/i }).click();
  await expect(page).toHaveURL(/dashboard/, { timeout: 10000 });
}

/** A shop with a confirmed order for `amount`, and stock behind it. */
async function shopWithOrder(request: APIRequestContext, amount = 1000) {
  const { headers, mk } = await apiCtx(request);
  const stamp = Date.now();
  const customer = await mk('customers', { displayName: `Cancel Shop ${stamp}`, type: 'B2B' });
  const { product } = await stockedProduct(request, headers, mk, `Cancel ${stamp}`);
  const order = await owedOrder(mk, customer.id, product.id, amount);
  return { headers, mk, customer, product, order };
}

test.describe('Cancelling an order', () => {
  test('TC-CANCEL-01: an unpaid order cancels and its stock comes back', async ({ request }) => {
    const { headers, mk, product, order } = await shopWithOrder(request);

    const stockBefore = await (async () => {
      const res = await request.get(`${API}/inventory`, { headers });
      const rows = (await res.json()).data ?? [];
      return Number(rows.find((r: any) => r.productId === product.id)?.availableStock ?? 0);
    })();

    await mk(`sales/orders/${order.id}/cancel`, {});

    const after = await request.get(`${API}/sales/orders/${order.id}`, { headers });
    expect(((await after.json()).data ?? {}).status).toBe('CANCELLED');

    const res = await request.get(`${API}/inventory`, { headers });
    const rows = (await res.json()).data ?? [];
    const stockAfter = Number(rows.find((r: any) => r.productId === product.id)?.availableStock ?? 0);
    // The order took one unit; cancelling gives it back.
    expect(stockAfter).toBeGreaterThan(stockBefore);
  });

  test('TC-CANCEL-02: an order that has been paid against cannot be cancelled', async ({
    request,
  }) => {
    const { headers, mk, customer, order } = await shopWithOrder(request);
    const payment = await mk('payments', {
      customerId: customer.id, amount: 400, currency: 'EGP', method: 'CASH',
    });
    await mk(`payments/${payment.id}/allocations`, { saleOrderId: order.id, amount: 400 });

    const res = await request.post(`${API}/sales/orders/${order.id}/cancel`, { headers });
    expect(res.status()).toBe(400);
    const message = JSON.stringify(await res.json());
    expect(message).toMatch(/400\.00/);
    expect(message).toMatch(/return/i);

    // Nothing moved: the order still stands and still owes what it owed.
    const after = await request.get(`${API}/sales/orders/${order.id}`, { headers });
    expect(((await after.json()).data ?? {}).status).not.toBe('CANCELLED');
    expect(await outstandingOf(request, headers, order.id)).toBe(600);
  });

  test('TC-CANCEL-03: a fully paid order cannot be cancelled either', async ({ request }) => {
    // PAID is the obvious case, and was reachable the same way.
    const { headers, mk, customer, order } = await shopWithOrder(request);
    const payment = await mk('payments', {
      customerId: customer.id, amount: 1000, currency: 'EGP', method: 'CASH',
    });
    await mk(`payments/${payment.id}/allocations`, { saleOrderId: order.id, amount: 1000 });

    const res = await request.post(`${API}/sales/orders/${order.id}/cancel`, { headers });
    expect(res.status()).toBe(400);
  });

  test('TC-CANCEL-04: cancelling twice is refused', async ({ request }) => {
    const { headers, mk, order } = await shopWithOrder(request);
    await mk(`sales/orders/${order.id}/cancel`, {});

    const res = await request.post(`${API}/sales/orders/${order.id}/cancel`, { headers });
    expect(res.status()).toBe(400);
    // And the stock is not handed back a second time.
    expect(JSON.stringify(await res.json())).toMatch(/already/i);
  });

  test('TC-CANCEL-05: the UI asks before cancelling, and Keep order does nothing', async ({
    page,
    request,
  }) => {
    // The button sits beside Confirm and the action cannot be undone.
    const { headers, order } = await shopWithOrder(request);

    await login(page);
    await page.goto(`${BASE}/en/sales`);
    await page
      .locator('tr', { hasText: order.orderNo })
      .first()
      .getByRole('button', { name: /view/i })
      .click();

    await page.getByRole('button', { name: /cancel order/i }).first().click();
    await expect(page.getByText(/cannot be undone/i)).toBeVisible({ timeout: 10000 });

    await page.getByRole('button', { name: /keep order/i }).click();

    const after = await request.get(`${API}/sales/orders/${order.id}`, { headers });
    expect(((await after.json()).data ?? {}).status).not.toBe('CANCELLED');
  });

  test('TC-CANCEL-06: a partially paid order offers no cancel button at all', async ({
    page,
    request,
  }) => {
    // It used to offer one here specifically — the single state where money
    // had certainly arrived.
    const { headers, mk, customer, order } = await shopWithOrder(request);
    const payment = await mk('payments', {
      customerId: customer.id, amount: 400, currency: 'EGP', method: 'CASH',
    });
    await mk(`payments/${payment.id}/allocations`, { saleOrderId: order.id, amount: 400 });

    await login(page);
    await page.goto(`${BASE}/en/sales`);
    await page
      .locator('tr', { hasText: order.orderNo })
      .first()
      .getByRole('button', { name: /view/i })
      .click();

    // The return route is offered instead.
    await expect(page.getByRole('button', { name: /record return/i })).toBeVisible({
      timeout: 10000,
    });
    await expect(page.getByRole('button', { name: /cancel order/i })).toHaveCount(0);
  });
});
