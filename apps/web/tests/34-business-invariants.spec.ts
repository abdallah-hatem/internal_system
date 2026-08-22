/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: Things the business does not allow
 * ═══════════════════════════════════════════════════════════════════════
 *  Every other suite here checks that a feature works. None of them tried to
 *  put the system into a state that makes no sense, which is why a shop could
 *  pay 500 against a 300 balance, money could be received a month from now,
 *  and a discount larger than the line produced an order totalling -9,899.
 *
 *  These tests are the opposite shape: each one asks for something the
 *  business would never accept and fails if it is allowed. They are cheap,
 *  they need no UI, and they are the tests that should have existed first.
 *
 *  Add to this file whenever a rule is agreed — the rule and its guard belong
 *  together, and a rule with no test here is a rule the code may already be
 *  breaking.
 */
import { test, expect, APIRequestContext } from '@playwright/test';

const API = 'http://localhost:3001/api/v1';
const EMAIL = 'partner.a@motoparts.com';
const PASSWORD = 'password123';

const dayFromNow = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
};

async function ctx(request: APIRequestContext) {
  const auth = await request.post(`${API}/auth/login`, {
    data: { email: EMAIL, password: PASSWORD },
  });
  const headers = { Authorization: `Bearer ${(await auth.json()).data.accessToken}` };
  const stamp = Date.now() + Math.floor(Math.random() * 1000);

  const mk = async (path: string, data: any) => {
    const res = await request.post(`${API}/${path}`, { headers, data });
    expect(res.ok(), `${path}: ${await res.text()}`).toBeTruthy();
    const body = await res.json();
    return body.data ?? body;
  };

  const customer = await mk('customers', { displayName: `Inv ${stamp}`, type: 'B2B' });
  const product = await mk('products', { name: `Inv Part ${stamp}`, minStock: 0 });
  const supplier = await mk('suppliers', { name: `Inv Sup ${stamp}`, country: 'AE' });

  /**
   * Put real stock behind the product.
   *
   * An order cannot be confirmed without it, and an unconfirmed order owes
   * nothing — so without this the payment rules could not be exercised at all.
   * It is the whole import pipeline because that is genuinely the only way
   * stock comes into existence here.
   */
  const stockUp = async (qty = 100) => {
    const cycle = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'EGP' });
    await mk(`cycles/${cycle.id}/purchases`, {
      supplierId: supplier.id, currency: 'EGP', fxRateToEgp: 1,
      orderedOn: dayFromNow(0),
      items: [{ productId: product.id, orderedQty: qty, unitPrice: 10 }],
    });
    await mk(`cycles/${cycle.id}/shipping-legs`, {
      sequence: 1, origin: 'Dubai, UAE', destination: 'Cairo, Egypt',
      provider: 'Inv Freight', costBasis: 'FLAT', amount: 0, currency: 'EGP', fxRateToEgp: 1,
    });
    for (const status of ['FUNDING', 'PURCHASING', 'ARRIVED_UAE', 'IN_TRANSIT_TO_EGYPT', 'ARRIVED_EGYPT', 'VERIFICATION']) {
      await mk(`cycles/${cycle.id}/transition`, { status });
    }
    const full = await (await request.get(`${API}/cycles/${cycle.id}`, { headers })).json();
    const poItem = (full.data ?? full).purchaseOrders[0].items[0];
    await mk('receipts/verify', {
      cycleId: cycle.id,
      items: [{ purchaseOrderItemId: poItem.id, productId: product.id, receivedQty: qty }],
    });
  };

  /** An order for this customer, confirmed so its balance is genuinely owed. */
  const owe = async (amount: number) => {
    const order = await mk('sales/orders', {
      customerId: customer.id, channel: 'B2B', currency: 'EGP',
      items: [{ productId: product.id, quantity: 1, unitPrice: amount, discount: 0 }],
    });
    await mk(`sales/orders/${order.id}/confirm`, { version: order.version });
    return order;
  };

  return { headers, mk, customer, product, supplier, request, stockUp, owe };
}

/** Post and return { status, message } without failing the test. */
async function attempt(request: APIRequestContext, headers: any, path: string, data: any) {
  const res = await request.post(`${API}/${path}`, { headers, data });
  let message = '';
  try {
    const body = await res.json();
    message = body?.error?.message ?? body?.message ?? '';
  } catch { /* non-JSON body */ }
  return { status: res.status(), message };
}

test.describe('Money cannot be dated forward', () => {
  test('TC-INV-01: a payment cannot be received in the future', async ({ request }) => {
    const { headers, customer } = await ctx(request);
    const r = await attempt(request, headers, 'payments', {
      customerId: customer.id, amount: 10, currency: 'EGP', method: 'CASH',
      receivedOn: dayFromNow(30),
    });
    expect(r.status, r.message).toBe(400);
    expect(r.message).toMatch(/future/i);
  });

  test('TC-INV-02: a purchase order cannot be placed in the future', async ({ request }) => {
    const { headers, mk, supplier, product } = await ctx(request);
    const cycle = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'AED' });
    const r = await attempt(request, headers, `cycles/${cycle.id}/purchases`, {
      supplierId: supplier.id, currency: 'AED', fxRateToEgp: 13.85,
      orderedOn: dayFromNow(30),
      items: [{ productId: product.id, orderedQty: 1, unitPrice: 1 }],
    });
    expect(r.status, r.message).toBe(400);
    expect(r.message).toMatch(/future/i);
  });

  test('TC-INV-03: today is still allowed', async ({ request }) => {
    // The guard must not be off by a day. Comparing instants rather than
    // calendar days would reject today for anyone east of Greenwich.
    const { headers, customer, stockUp, owe } = await ctx(request);
    await stockUp();
    const order = await owe(100);

    const r = await attempt(request, headers, 'payments', {
      customerId: customer.id, amount: 100, currency: 'EGP', method: 'CASH',
      receivedOn: dayFromNow(0),
    });
    expect(r.status, r.message).toBeLessThan(400);
  });
});

test.describe('A shop cannot pay more than it owes', () => {
  test('TC-INV-04: paying 500 against a 300 balance is refused', async ({ request }) => {
    const { headers, customer, stockUp, owe } = await ctx(request);
    await stockUp();
    const order = await owe(300);

    const r = await attempt(request, headers, 'payments', {
      customerId: customer.id, amount: 500, currency: 'EGP', method: 'CASH',
    });
    expect(r.status, r.message).toBe(400);
    expect(r.message).toMatch(/owes|nothing to pay/i);
  });

  test('TC-INV-05: paying exactly what is owed is allowed', async ({ request }) => {
    const { headers, customer, stockUp, owe } = await ctx(request);
    await stockUp();
    const order = await owe(300);

    const r = await attempt(request, headers, 'payments', {
      customerId: customer.id, amount: 300, currency: 'EGP', method: 'CASH',
    });
    expect(r.status, r.message).toBeLessThan(400);
  });

  test('TC-INV-06: a payment cannot be allocated beyond an order\'s balance', async ({ request }) => {
    const { headers, mk, customer, stockUp, owe } = await ctx(request);
    await stockUp();
    const order = await owe(300);
    const payment = await mk('payments', {
      customerId: customer.id, amount: 300, currency: 'EGP', method: 'CASH',
    });

    const r = await attempt(request, headers, `payments/${payment.id}/allocations`, {
      saleOrderId: order.id, amount: 500,
    });
    expect(r.status, r.message).toBe(400);
  });
});

test.describe('An order cannot be worth less than nothing', () => {
  test('TC-INV-07: a discount larger than the line is refused', async ({ request }) => {
    // Real stock, so the order is refused for its discount rather than for
    // having nothing to sell — otherwise this passes on the wrong rule.
    const { headers, customer, product, stockUp } = await ctx(request);
    await stockUp(10);
    const r = await attempt(request, headers, 'sales/orders', {
      customerId: customer.id, channel: 'B2B', currency: 'EGP',
      items: [{ productId: product.id, quantity: 1, unitPrice: 100, discount: 9999 }],
    });
    expect(r.status, r.message).toBe(400);
    expect(r.message).toMatch(/discount/i);
  });

  test('TC-INV-08: negative quantities and prices are refused', async ({ request }) => {
    const { headers, customer, product, stockUp } = await ctx(request);
    await stockUp(10);

    const qty = await attempt(request, headers, 'sales/orders', {
      customerId: customer.id, channel: 'B2B', currency: 'EGP',
      items: [{ productId: product.id, quantity: -5, unitPrice: 100, discount: 0 }],
    });
    expect(qty.status, qty.message).toBe(400);

    const price = await attempt(request, headers, 'sales/orders', {
      customerId: customer.id, channel: 'B2B', currency: 'EGP',
      items: [{ productId: product.id, quantity: 1, unitPrice: -100, discount: 0 }],
    });
    expect(price.status, price.message).toBe(400);
  });
});

test.describe('Records must point at things that exist', () => {
  test('TC-INV-09: a payment for an unknown customer says so, rather than failing at 500', async ({
    request,
  }) => {
    const { headers } = await ctx(request);
    const r = await attempt(request, headers, 'payments', {
      customerId: '00000000-0000-4000-8000-000000000999',
      amount: 10, currency: 'EGP', method: 'CASH',
    });
    // A 500 here is its own bug: the foreign key failed deep in the driver and
    // surfaced as "An unexpected error occurred", which tells nobody anything.
    expect(r.status, r.message).toBe(404);
    expect(r.message).toMatch(/customer/i);
  });
});

test.describe('Revenue is counted once, when the money arrives', () => {
  test('TC-INV-10: confirming a sale raises no revenue; being paid does', async ({ request }) => {
    // DECIDED 2026-08-22. Revenue was booked twice — on confirm and again on
    // each payment — so 31,200 of orders produced 72,710 of ledger revenue.
    // The sale is not the money; the shop takes the goods and pays later.
    const { headers, mk, customer, stockUp, owe, request: req } = await ctx(request);
    await stockUp();

    const revenueTotal = async () => {
      const res = await req.get(`${API}/ledger?limit=200`, { headers });
      const rows = (await res.json()).data ?? [];
      return rows
        .filter((r: any) => r.category === 'revenue')
        .reduce((sum: number, r: any) => sum + Number(r.amount), 0);
    };

    const before = await revenueTotal();
    await owe(300);

    // Sold, not collected: the ledger has not moved.
    expect(await revenueTotal()).toBe(before);

    await mk('payments', {
      customerId: customer.id, amount: 300, currency: 'EGP', method: 'CASH',
    });

    // Collected: counted once, for what actually arrived.
    expect(await revenueTotal()).toBe(before + 300);
  });

  test('TC-INV-11: the dashboard separates what was sold from what was collected', async ({
    request,
  }) => {
    // The gap between them is the money still to come, which is the figure the
    // owner asked to be able to see.
    const { headers, mk, customer, stockUp, owe, request: req } = await ctx(request);
    await stockUp();
    const order = await owe(1000);

    const dash = async () => {
      const res = await req.get(`${API}/analytics/dashboard`, { headers });
      return (await res.json()).data;
    };

    const sold = await dash();
    expect(Number(sold.receivables)).toBeGreaterThanOrEqual(1000);

    const payment = await mk('payments', {
      customerId: customer.id, amount: 400, currency: 'EGP', method: 'CASH',
    });

    // Recording the money and putting it against the debt are two steps at
    // this level — receivables move on the second, not the first. The customer
    // page does both in one action, which is why it exists.
    const banked = await dash();
    expect(Number(banked.collected) - Number(sold.collected)).toBe(400);
    expect(Number(banked.receivables)).toBe(Number(sold.receivables));

    await mk(`payments/${payment.id}/allocations`, {
      saleOrderId: order.id, amount: 400,
    });

    const applied = await dash();
    expect(Number(sold.receivables) - Number(applied.receivables)).toBe(400);
  });
});

test.describe('You cannot sell what you do not have', () => {
  test('TC-INV-12: an order for more than is in stock is refused', async ({ request }) => {
    // Only confirming checked this. An order for 600 against 60 in stock was
    // built, priced at 720,000 and saved, and objected to nowhere.
    const { headers, customer, product, stockUp } = await ctx(request);
    await stockUp(60);

    const r = await attempt(request, headers, 'sales/orders', {
      customerId: customer.id, channel: 'B2B', currency: 'EGP',
      items: [{ productId: product.id, quantity: 600, unitPrice: 1200, discount: 0 }],
    });
    expect(r.status, r.message).toBe(400);
    expect(r.message).toMatch(/in stock/i);
  });

  test('TC-INV-13: two lines of the same product are counted together', async ({ request }) => {
    // 40 and 40 against 60 is 80. Checked line by line, each looks fine — which
    // is exactly how a per-item guard lets an over-sale through.
    const { headers, customer, product, stockUp } = await ctx(request);
    await stockUp(60);

    const r = await attempt(request, headers, 'sales/orders', {
      customerId: customer.id, channel: 'B2B', currency: 'EGP',
      items: [
        { productId: product.id, quantity: 40, unitPrice: 1200, discount: 0 },
        { productId: product.id, quantity: 40, unitPrice: 1200, discount: 0 },
      ],
    });
    expect(r.status, r.message).toBe(400);
    expect(r.message).toMatch(/80/);
  });

  test('TC-INV-14: selling exactly what is there is allowed', async ({ request }) => {
    // The guard must stop at the boundary, not before it — refusing the last
    // 60 units of 60 would make stock unsellable.
    const { headers, customer, product, stockUp } = await ctx(request);
    await stockUp(60);

    const r = await attempt(request, headers, 'sales/orders', {
      customerId: customer.id, channel: 'B2B', currency: 'EGP',
      items: [{ productId: product.id, quantity: 60, unitPrice: 1200, discount: 0 }],
    });
    expect(r.status, r.message).toBeLessThan(400);
  });

  test('TC-INV-15: stock already sold is no longer available to sell again', async ({
    request,
  }) => {
    // The second order must see what the first one took. Availability read from
    // received rather than saleable quantity would let the same units go twice.
    const { headers, mk, customer, product, stockUp } = await ctx(request);
    await stockUp(60);

    const first = await mk('sales/orders', {
      customerId: customer.id, channel: 'B2B', currency: 'EGP',
      items: [{ productId: product.id, quantity: 50, unitPrice: 1200, discount: 0 }],
    });
    await mk(`sales/orders/${first.id}/confirm`, { version: first.version });

    const r = await attempt(request, headers, 'sales/orders', {
      customerId: customer.id, channel: 'B2B', currency: 'EGP',
      items: [{ productId: product.id, quantity: 20, unitPrice: 1200, discount: 0 }],
    });
    expect(r.status, r.message).toBe(400);
    expect(r.message).toMatch(/10\.000/);
  });
});
