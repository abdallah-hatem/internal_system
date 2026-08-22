/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: A payment only pays the customer who made it
 * ═══════════════════════════════════════════════════════════════════════
 *  Allocation checked that the order existed and that it still owed enough,
 *  and never that it belonged to the payer. The picker offered every order in
 *  the system by number, so clearing the wrong shop's debt was one wrong click
 *  — and it left both balances wrong with nothing to show for it.
 */
import { test, expect, APIRequestContext } from '@playwright/test';

import { apiCtx, stockedProduct, owedOrder, API } from './support/fixtures';

/**
 * Two unrelated shops: the second genuinely owes 500, the first has paid 500.
 *
 * The orders are confirmed and the stock is real, because a draft owes nothing
 * and a payment against nothing is now refused before allocation is ever
 * reached — an earlier version of this fixture tested neither rule.
 */
async function twoShops(request: APIRequestContext) {
  const { headers, mk } = await apiCtx(request);
  const stamp = Date.now();

  const payer = await mk('customers', { displayName: `Payer ${stamp}`, type: 'B2B' });
  const other = await mk('customers', { displayName: `Other ${stamp}`, type: 'B2B' });
  const { product } = await stockedProduct(request, headers, mk, `Alloc ${stamp}`);

  const othersOrder = await owedOrder(mk, other.id, product.id, 500);
  const payersOrder = await owedOrder(mk, payer.id, product.id, 500);

  const payment = await mk('payments', {
    customerId: payer.id, amount: 500, currency: 'EGP', method: 'CASH', receivedOn: undefined,
  });

  return { headers, mk, payer, other, product, payment, othersOrder, payersOrder };
}

test.describe('Payment allocation', () => {
  test("TC-ALLOC-01: a payment cannot be allocated to another customer's order", async ({
    request,
  }) => {
    const { headers, payment, othersOrder } = await twoShops(request);

    const res = await request.post(`${API}/payments/${payment.id}/allocations`, {
      headers,
      data: { saleOrderId: othersOrder.id, amount: 500 },
    });

    expect(res.status()).toBe(400);
    expect(JSON.stringify(await res.json())).toMatch(/different customer/i);

    // And the other shop still owes every piastre of it.
    const after = await request.get(`${API}/sales/orders/${othersOrder.id}`, { headers });
    const order = (await after.json()).data ?? (await after.json());
    expect(Number(order.outstanding)).toBe(500);
  });

  test("TC-ALLOC-02: the payer's own order still allocates normally", async ({ request }) => {
    // The guard must refuse the wrong customer without breaking the right one.
    const { headers, payment, payersOrder } = await twoShops(request);

    const res = await request.post(`${API}/payments/${payment.id}/allocations`, {
      headers,
      data: { saleOrderId: payersOrder.id, amount: 500 },
    });
    expect(res.ok(), await res.text()).toBeTruthy();

    const after = await request.get(`${API}/sales/orders/${payersOrder.id}`, { headers });
    expect(Number(((await after.json()).data ?? {}).outstanding)).toBe(0);
  });
});
