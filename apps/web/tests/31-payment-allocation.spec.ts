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

const API = 'http://localhost:3001/api/v1';
const EMAIL = 'partner.a@motoparts.com';
const PASSWORD = 'password123';

async function token(request: APIRequestContext) {
  const auth = await request.post(`${API}/auth/login`, {
    data: { email: EMAIL, password: PASSWORD },
  });
  return (await auth.json()).data.accessToken;
}

/** Two unrelated shops, one order owed by the second, one payment from the first. */
async function twoShops(request: APIRequestContext) {
  const t = await token(request);
  const headers = { Authorization: `Bearer ${t}` };
  const stamp = Date.now();

  const mk = async (path: string, data: any) => {
    const res = await request.post(`${API}/${path}`, { headers, data });
    expect(res.ok(), `${path}: ${await res.text()}`).toBeTruthy();
    const body = await res.json();
    return body.data ?? body;
  };

  const payer = await mk('customers', { displayName: `Payer ${stamp}`, type: 'B2B' });
  const other = await mk('customers', { displayName: `Other ${stamp}`, type: 'B2B' });
  const product = await mk('products', { name: `Alloc Part ${stamp}`, minStock: 0 });

  const othersOrder = await mk('sales/orders', {
    customerId: other.id,
    channel: 'B2B',
    currency: 'EGP',
    items: [{ productId: product.id, quantity: 1, unitPrice: 500, discount: 0 }],
  });

  const payment = await mk('payments', {
    customerId: payer.id,
    amount: 500,
    currency: 'EGP',
    method: 'CASH',
    receivedOn: '2026-08-22',
  });

  return { headers, payer, other, payment, othersOrder };
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

  test('TC-ALLOC-02: the payer\'s own order still allocates normally', async ({ request }) => {
    // The guard must refuse the wrong customer without breaking the right one.
    const { headers, payer, payment } = await twoShops(request);
    const stamp = Date.now();

    const prodRes = await request.post(`${API}/products`, {
      headers, data: { name: `Own Part ${stamp}`, minStock: 0 },
    });
    const product = (await prodRes.json()).data;

    const ownRes = await request.post(`${API}/sales/orders`, {
      headers,
      data: {
        customerId: payer.id,
        channel: 'B2B',
        currency: 'EGP',
        items: [{ productId: product.id, quantity: 1, unitPrice: 500, discount: 0 }],
      },
    });
    const own = (await ownRes.json()).data;

    const res = await request.post(`${API}/payments/${payment.id}/allocations`, {
      headers,
      data: { saleOrderId: own.id, amount: 500 },
    });
    expect(res.ok(), await res.text()).toBeTruthy();

    const after = await request.get(`${API}/sales/orders/${own.id}`, { headers });
    expect(Number(((await after.json()).data ?? {}).outstanding)).toBe(0);
  });
});
