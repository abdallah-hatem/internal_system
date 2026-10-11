/* eslint-disable @typescript-eslint/no-explicit-any -- API responses are parsed JSON; each assertion names the field it checks */
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
import { apiCtx, giveStock, stockedProduct, owedOrder, outstandingOf, refusedCallers } from './support/fixtures';

/**
 * Where the flows run. Defaults to the local API; `API_BASE` points the same
 * suite at the deployed one, which is the only way these flows get exercised
 * against a compiled bundle, a serverless host and Neon.
 */
const API = process.env.API_BASE ?? 'http://localhost:3001/api/v1';
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
      // A cycle cannot pass a stage its shipment has not reached, so these
      // dates are what make the stock exist at all.
      departedOn: dayFromNow(-20), arrivedOn: dayFromNow(-5),
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

test.describe('Goods cannot be counted twice on the way (§1, §3 — 2026-10-10)', () => {
  /** A cycle with 10 ordered and its one leg departed, nothing arrived. */
  async function shipped(request: APIRequestContext) {
    const { headers, mk, product, supplier } = await ctx(request);
    const cycle = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'EGP' });
    await mk(`cycles/${cycle.id}/purchases`, {
      supplierId: supplier.id, currency: 'EGP', fxRateToEgp: 1,
      orderedOn: dayFromNow(-25),
      items: [{ productId: product.id, orderedQty: 10, unitPrice: 10 }],
    });
    const leg = await mk(`cycles/${cycle.id}/shipping-legs`, {
      sequence: 1, origin: 'Dubai, UAE', destination: 'Cairo, Egypt',
      costBasis: 'FLAT', amount: 0, currency: 'EGP', fxRateToEgp: 1,
      departedOn: dayFromNow(-20),
    });
    const full = await (await request.get(`${API}/cycles/${cycle.id}`, { headers })).json();
    const item = (full.data ?? full).purchaseOrders[0].items[0];
    return { headers, mk, cycle, leg, item, product };
  }

  test('TC-INV-16: a leg cannot deliver more than entered it (delivered ≤ entered)', async ({ request }) => {
    const { headers, leg, item } = await shipped(request);
    const one = await attempt(request, headers, `shipping/legs/${leg.id}/deliveries`, {
      arrivedOn: dayFromNow(-5), lines: [{ purchaseOrderItemId: item.id, qty: 10 }],
    });
    expect(one.status, one.message).toBeLessThan(300);
    // Ten entered, ten came. An eleventh is a unit counted twice.
    const again = await attempt(request, headers, `shipping/legs/${leg.id}/deliveries`, {
      arrivedOn: dayFromNow(-4), lines: [{ purchaseOrderItemId: item.id, qty: 1 }],
    });
    expect(again.status, again.message).toBe(400);
  });

  test('TC-INV-17: received + lost can never pass what was ordered', async ({ request }) => {
    // Everything ordered was delivered and received into stock: nothing is
    // left that could be lost. Marking one lost would put 11 of 10 somewhere —
    // in stock and lost at once.
    const { headers, mk, cycle, leg, item, product } = await shipped(request);
    await mk(`shipping/legs/${leg.id}/deliveries`, {
      arrivedOn: dayFromNow(-5), lines: [{ purchaseOrderItemId: item.id, qty: 10 }],
    });
    for (const status of ['FUNDING', 'PURCHASING', 'ARRIVED_UAE', 'IN_TRANSIT_TO_EGYPT', 'ARRIVED_EGYPT', 'VERIFICATION']) {
      await mk(`cycles/${cycle.id}/transition`, { status });
    }
    await mk('receipts/verify', {
      cycleId: cycle.id,
      items: [{ purchaseOrderItemId: item.id, productId: product.id, receivedQty: 10 }],
    });
    const lost = await attempt(request, headers, `shipping/legs/${leg.id}/losses`, {
      lines: [{ purchaseOrderItemId: item.id, qty: 1 }],
    });
    expect(lost.status, lost.message).toBe(400);
  });
});

test.describe('A line costs what it cost, once; a cycle settles only when accounted (§2, §8 — 2026-10-10)', () => {
  /**
   * 3 spark plugs that cost nothing, shipped for 100: 33.3333 a unit, so three
   * events at 33.33 would leave the line a piastre short. One leg departed.
   */
  async function threeForAHundred(request: APIRequestContext) {
    const { headers, mk, product, supplier } = await ctx(request);
    const cycle = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'EGP' });
    await mk(`cycles/${cycle.id}/purchases`, {
      supplierId: supplier.id, currency: 'EGP', fxRateToEgp: 1,
      orderedOn: dayFromNow(-25),
      items: [{ productId: product.id, orderedQty: 3, unitPrice: 0 }],
    });
    const leg = await mk(`cycles/${cycle.id}/shipping-legs`, {
      sequence: 1, origin: 'Dubai, UAE', destination: 'Cairo, Egypt',
      costBasis: 'FLAT', amount: 100, currency: 'EGP', fxRateToEgp: 1,
      departedOn: dayFromNow(-20),
    });
    const full = await (await request.get(`${API}/cycles/${cycle.id}`, { headers })).json();
    const item = (full.data ?? full).purchaseOrders[0].items[0];
    return { headers, mk, cycle, leg, item };
  }

  /** A delivery of `qty`, and the cycle walked to Arrived Egypt behind it. */
  async function arrived(mk: any, cycle: any, leg: any, item: any, qty: number) {
    const delivery = await mk(`shipping/legs/${leg.id}/deliveries`, {
      arrivedOn: dayFromNow(-5), lines: [{ purchaseOrderItemId: item.id, qty }],
    });
    for (const status of ['FUNDING', 'PURCHASING', 'ARRIVED_UAE', 'IN_TRANSIT_TO_EGYPT', 'ARRIVED_EGYPT']) {
      await mk(`cycles/${cycle.id}/transition`, { status });
    }
    return delivery;
  }

  test('TC-INV-18: batches + losses re-sum to the line’s landed total', async ({ request }) => {
    const { headers, mk, cycle, leg, item } = await threeForAHundred(request);
    const delivery = await arrived(mk, cycle, leg, item, 2);
    for (let i = 0; i < 2; i++) {
      await mk('receipts/verify', {
        cycleId: cycle.id, deliveryId: delivery.id,
        items: [{ deliveryLineId: delivery.lines[0].id, receivedQty: 1 }],
      });
    }
    await mk(`shipping/legs/${leg.id}/losses`, {
      lines: [{ purchaseOrderItemId: item.id, qty: 1 }],
    });

    // What each receipt cost is its ledger row; what the loss cost is its own.
    const ledger = await (await request.get(`${API}/ledger?cycleId=${cycle.id}&limit=20`, { headers })).json();
    const rows: any[] = ledger.data?.items ?? ledger.data ?? [];
    const received = rows
      .filter((t) => t.category === 'purchase' && t.relatedId === item.id)
      .reduce((s, t) => s + Math.round(Number(t.amount) * 100), 0);
    const shipment = (await (await request.get(`${API}/cycles/${cycle.id}/shipment`, { headers })).json()).data;
    const lost = shipment.legs
      .flatMap((l: any) => l.losses)
      .reduce((s: number, x: any) => s + Math.round(Number(x.costEgp) * 100), 0);
    const landed = await (await request.get(`${API}/costing/cycles/${cycle.id}/landed-cost`, { headers })).json();
    const total = Math.round(Number((landed.data ?? landed).items[0].totalLandedCostEgp) * 100);

    expect(total).toBe(10000);
    expect(received + lost, 'batches + losses must re-sum to the line total').toBe(total);
  });

  test('TC-INV-19: no settlement with goods on the way', async ({ request }) => {
    const { headers, mk, cycle, leg, item } = await threeForAHundred(request);
    const delivery = await arrived(mk, cycle, leg, item, 2);
    await mk('receipts/verify', {
      cycleId: cycle.id, deliveryId: delivery.id,
      items: [{ deliveryLineId: delivery.lines[0].id, receivedQty: 2 }],
    });

    // One unit still on the way: neither route into settlement is open.
    const moved = await attempt(request, headers, `cycles/${cycle.id}/transition`, { status: 'SETTLEMENT' });
    expect(moved.status, moved.message).toBe(400);
    const calc = await request.post(`${API}/settlements/calculate/${cycle.id}`, { headers });
    if (calc.ok()) {
      const settlement = (await calc.json()).data;
      const approved = await attempt(request, headers, `settlements/${settlement.id}/approve`, {});
      expect(approved.status, approved.message).toBe(400);
    }
    const now = await (await request.get(`${API}/cycles/${cycle.id}`, { headers })).json();
    expect((now.data ?? now).status).toBe('SELLING');
  });
});

test.describe('Compensation recovers a loss, never more (§6 — 2026-10-10)', () => {
  test('TC-INV-20: refunds on a loss never exceed its cost', async ({ request }) => {
    // 10 at 100 and a 400 leg: 140 a unit landed. 5 lost on the way = 700.
    const { headers, mk, product, supplier } = await ctx(request);
    const provider = await mk('providers', { name: `Inv Freight ${Date.now()}` });
    const cycle = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'EGP' });
    await mk(`cycles/${cycle.id}/purchases`, {
      supplierId: supplier.id, currency: 'EGP', fxRateToEgp: 1,
      orderedOn: dayFromNow(-25),
      items: [{ productId: product.id, orderedQty: 10, unitPrice: 100 }],
    });
    const leg = await mk(`cycles/${cycle.id}/shipping-legs`, {
      sequence: 1, origin: 'Dubai, UAE', destination: 'Cairo, Egypt', providerId: provider.id,
      costBasis: 'FLAT', amount: 400, currency: 'EGP', fxRateToEgp: 1,
      departedOn: dayFromNow(-20),
    });
    const full = await (await request.get(`${API}/cycles/${cycle.id}`, { headers })).json();
    const item = (full.data ?? full).purchaseOrders[0].items[0];
    const [loss] = await mk(`shipping/legs/${leg.id}/losses`, {
      lines: [{ purchaseOrderItemId: item.id, qty: 5 }],
    });
    expect(Number(loss.costEgp)).toBe(700);

    const body = (amount: number, extra: object = {}) => ({
      amount, currency: 'EGP', fxRateToEgp: 1, recordedOn: dayFromNow(0),
      payer: { type: 'SHIPPING_PROVIDER', id: provider.id }, ...extra,
    });
    // Three at once that only fit two at a time, then one in another
    // currency that would cross the line in EGP but not in its own figure.
    await Promise.all([300, 300, 300].map((a) =>
      attempt(request, headers, `shipping/losses/${loss.id}/refunds`, body(a))));
    const usd = await attempt(request, headers, `shipping/losses/${loss.id}/refunds`,
      body(3, { currency: 'USD', fxRateToEgp: 50 }));
    expect(usd.status, usd.message).toBe(400);

    const shipment = (await (await request.get(`${API}/cycles/${cycle.id}/shipment`, { headers })).json()).data;
    const read = shipment.losses.find((x: any) => x.id === loss.id);
    const refunded = read.refunds.reduce((s: number, r: any) => s + Math.round(Number(r.amountEgp) * 100), 0);
    expect(refunded, 'refunds must stay within the loss cost').toBeLessThanOrEqual(70000);
    expect(refunded).toBe(60000);
    expect(Number(read.unrecoveredEgp)).toBe(100);
  });
});

/** The scheduler's secret on a local API (scripts/dev.sh sets this default). */
const CRON = process.env.CRON_SECRET ?? 'local-cron-secret';

test.describe('An overdue instalment is told once, to every partner (§7 — 2026-10-11)', () => {
  test('TC-INV-21: the daily check run again tells nobody anything twice', async ({ request }) => {
    const { headers, mk } = await apiCtx(request);
    const customer = await mk('customers', { displayName: `Inv Overdue ${Date.now()}`, type: 'B2B' });
    const { product } = await stockedProduct(request, headers, mk, `InvOverdue-${Date.now()}`, 5);
    await owedOrder(mk, customer.id, product.id, 10_000);
    await mk('payment-plans', {
      customerId: customer.id,
      agreedOn: dayFromNow(-20),
      instalments: [{ dueOn: dayFromNow(-10), amount: 3000 }, { dueOn: dayFromNow(-2), amount: 2000 }],
    });

    const run = async () => {
      const res = await request.get(`${API}/jobs/overdue-payments`, { headers: { Authorization: `Bearer ${CRON}` } });
      expect(res.status(), await res.text()).toBe(200);
      return res.json();
    };
    const first = await run();
    const second = await run();
    const third = await run();

    expect(first.notifications, 'the first run tells each partner about each instalment').toBeGreaterThanOrEqual(2);
    expect([second.notifications, third.notifications]).toEqual([0, 0]);

    const notes = (await (await request.get(`${API}/notifications?limit=100`, { headers })).json()).data
      .filter((n: any) => n.eventType === 'PAYMENT_OVERDUE' && n.payloadJson?.customerId === customer.id);
    expect(notes.map((n: any) => n.params.amount).sort()).toEqual(['2,000.00', '3,000.00']);
  });

  test('TC-INV-22b: reading the overdue summary tells nobody', async ({ request }) => {
    const { headers } = await apiCtx(request);
    const count = async () =>
      ((await (await request.get(`${API}/notifications?limit=100`, { headers })).json()).data ?? [])
        .filter((n: any) => n.eventType === 'PAYMENT_OVERDUE').length;
    const before = await count();
    for (let i = 0; i < 3; i++) await request.get(`${API}/payment-plans/overdue`, { headers });
    expect(await count()).toBe(before);
  });

  test('TC-INV-22: an investor is not told about shops’ debts', async ({ request }) => {
    // Customer data is the office's (roles, 2026-10-10): the check names only core partners.
    const login = await request.post(`${API}/auth/login`, {
      data: { email: 'investor@motoparts.com', password: PASSWORD },
    });
    const headers = { Authorization: `Bearer ${(await login.json()).data.accessToken}` };
    await request.get(`${API}/jobs/overdue-payments`, { headers: { Authorization: `Bearer ${CRON}` } });
    const notes = (await (await request.get(`${API}/notifications?limit=100`, { headers })).json()).data ?? [];
    expect(notes.filter((n: any) => n.eventType === 'PAYMENT_OVERDUE')).toEqual([]);
  });
});

test.describe('A sale that takes stock under its minimum says so, once (§3 — 2026-10-11)', () => {
  /** Low-stock alerts naming this product in partner A's bell. */
  async function lowAlerts(request: APIRequestContext, headers: any, productId: string) {
    const notes = (await (await request.get(`${API}/notifications?limit=100`, { headers })).json()).data ?? [];
    return notes.filter(
      (n: any) => n.eventType === 'LOW_STOCK_DETECTED' && n.payloadJson?.products?.some((p: any) => p.productId === productId),
    );
  }
  /** A product with a minimum of 10 and 12 really received — not low yet. */
  async function twelveOverTen(request: APIRequestContext, label: string) {
    const { headers, mk } = await apiCtx(request);
    const product = await mk('products', { name: `${label} ${Date.now()}`, minStock: 10 });
    await giveStock(request, headers, mk, product.id, `${label}-${Date.now()}`, 12);
    return { headers, mk, product };
  }
  const shopSale = (customerId: string, productId: string, quantity: number) => ({
    customerId, channel: 'B2B', currency: 'EGP', confirm: true,
    items: [{ productId, quantity, unitPrice: 100, discount: 0 }],
  });

  test('TC-INV-23: a sale crossing the minimum alerts once; more sales while low stay quiet', async ({ request }) => {
    const { headers, mk, product } = await twelveOverTen(request, 'Inv Low');
    const customer = await mk('customers', { displayName: `Inv Low Shop ${Date.now()}`, type: 'B2B' });
    expect(await lowAlerts(request, headers, product.id), 'receiving 12 over a minimum of 10 is not low').toEqual([]);

    await mk('sales/orders', shopSale(customer.id, product.id, 2)); // 10 left: at the minimum, not low
    expect(await lowAlerts(request, headers, product.id)).toEqual([]);

    await mk('sales/orders', shopSale(customer.id, product.id, 1)); // 9: crossed
    await mk('sales/orders', shopSale(customer.id, product.id, 4)); // 5: still low
    await mk('sales/orders', shopSale(customer.id, product.id, 5)); // 0: still low

    const alerts = await lowAlerts(request, headers, product.id);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].payloadJson.products.find((p: any) => p.productId === product.id)).toMatchObject({
      currentStock: 9, minStock: 10,
    });
  });

  test('TC-INV-24: a walk-in sale crossing the minimum alerts too; a refused one does not', async ({ request }) => {
    const { headers, mk, product } = await twelveOverTen(request, 'Inv Low Walk-in');
    const walkIn = (quantity: number) => ({
      walkIn: true, currency: 'EGP', items: [{ productId: product.id, quantity, unitPrice: 450, discount: 0 }],
    });

    const tooMany = await attempt(request, headers, 'sales/orders', walkIn(13));
    expect(tooMany.status, tooMany.message).toBe(400);
    expect(await lowAlerts(request, headers, product.id)).toEqual([]);

    await mk('sales/orders', walkIn(4)); // 8: crossed
    expect(await lowAlerts(request, headers, product.id)).toHaveLength(1);
  });

  test('TC-INV-25: back above the minimum and down again is a new alert', async ({ request }) => {
    const { headers, mk, product } = await twelveOverTen(request, 'Inv Low Again');
    const customer = await mk('customers', { displayName: `Inv Again Shop ${Date.now()}`, type: 'B2B' });
    const draft = await mk('sales/orders', { ...shopSale(customer.id, product.id, 5), confirm: false });
    await mk(`sales/orders/${draft.id}/confirm`, { version: draft.version }); // 7: crossed
    await mk(`sales/orders/${draft.id}/cancel`, {}); // 12 again: not low
    await mk('sales/orders', shopSale(customer.id, product.id, 3)); // 9: crossed again

    expect(await lowAlerts(request, headers, product.id)).toHaveLength(2);
  });
});

test.describe('A statement closes at the balance the app shows (§7b — 2026-10-11)', () => {
  /** The closing balance of a statement running to today, and the balance the shop's page and list show. */
  async function both(request: APIRequestContext, headers: any, customerId: string) {
    const st = (await (await request.get(`${API}/customers/${customerId}/statement`, { headers })).json()).data;
    const page = (await (await request.get(`${API}/customers/${customerId}`, { headers })).json()).data;
    return { st, shown: Number(page.outstandingBalance) };
  }

  test('TC-INV-26: sales, payments oldest first, a credit note, a full cash return and a reversal — the statement closes at the balance, row by row', async ({ request }) => {
    const { headers, mk } = await apiCtx(request);
    const stamp = Date.now();
    const { product } = await stockedProduct(request, headers, mk, `Inv Statement ${stamp}`, 40);
    const customer = await mk('customers', { displayName: `Inv Statement Shop ${stamp}`, type: 'B2B' });
    const sell = async (quantity: number, unitPrice: number) =>
      mk('sales/orders', {
        customerId: customer.id, channel: 'B2B', currency: 'EGP', confirm: true,
        items: [{ productId: product.id, quantity, unitPrice, discount: 0 }],
      });

    const a = await sell(1, 3000);
    const b = await sell(2, 2000);
    // Neither of these owes anything, and neither may appear.
    await mk('sales/orders', {
      customerId: customer.id, channel: 'B2B', currency: 'EGP',
      items: [{ productId: product.id, quantity: 1, unitPrice: 9999, discount: 0 }],
    });
    const cancelled = await sell(1, 7777);
    await mk(`sales/orders/${cancelled.id}/cancel`, {});

    await mk('payments', { customerId: customer.id, amount: 3500, currency: 'EGP', applyOldestFirst: true });
    const bItem = (await (await request.get(`${API}/sales/orders/${b.id}`, { headers })).json()).data.items[0];
    await mk('returns', { saleOrderId: b.id, reason: 'one came back', refundMethod: 'CREDIT_NOTE', items: [{ saleItemId: bItem.id, qty: 1 }] });

    const c = await sell(1, 1000);
    const onC = await mk('payments', { customerId: customer.id, amount: 200, currency: 'EGP', orderId: c.id });
    const cItem = (await (await request.get(`${API}/sales/orders/${c.id}`, { headers })).json()).data.items[0];
    await mk('returns', { saleOrderId: c.id, reason: 'all of it back', refundMethod: 'CASH', items: [{ saleItemId: cItem.id, qty: 1 }] });
    await mk(`payments/${onC.id}/reverse`, { reason: 'cheque bounced' });

    const { st, shown } = await both(request, headers, customer.id);
    // a 0, b 4000 - 500 - 2000 = 1500, c owed again after the reversal: 1000.
    expect(shown).toBe(2500);
    expect(Number(st.closingBalance)).toBe(shown);
    expect(Number(st.openingBalance)).toBe(0);
    const refs = st.rows.map((r: any) => r.reference);
    expect(refs).toContain(a.orderNo);
    expect(refs).not.toContain(cancelled.orderNo);
    expect(st.rows.filter((r: any) => r.kind === 'SALE')).toHaveLength(3);
    // Every row's balance is the one before it plus what it did.
    let running = Number(st.openingBalance);
    for (const row of st.rows) {
      running = Math.round((running + Number(row.effect)) * 100) / 100;
      expect(Number(row.balance), `${row.kind} ${row.reference}`).toBe(running);
    }
    expect(running).toBe(shown);
  });

  test('TC-INV-27: every customer in the system — whatever earlier suites left — closes at the balance the list shows', async ({ request }) => {
    const { headers } = await apiCtx(request);
    const list = (await (await request.get(`${API}/customers?verification=ALL&limit=200`, { headers })).json()).data;
    expect(list.length).toBeGreaterThan(0);
    for (const customer of list) {
      const st = (await (await request.get(`${API}/customers/${customer.id}/statement`, { headers })).json()).data;
      expect(Number(st.closingBalance), customer.displayName).toBe(Number(customer.outstandingBalance));
    }
  });

  test('TC-INV-28: a statement is the office\'s — an investor and a shop owner are refused, a stranger id is not found, and a walk-in has none', async ({ request }) => {
    const { headers, mk } = await apiCtx(request);
    const customer = await mk('customers', { displayName: `Inv Statement Fence ${Date.now()}`, type: 'B2B' });
    for (const who of await refusedCallers(request, 'inv-st')) {
      const res = await request.get(`${API}/customers/${customer.id}/statement`, { headers: who.headers });
      expect(res.status(), who.who).toBe(403);
      expect((await res.json()).error.code, who.who).toBe(who.code);
    }
    const missing = await request.get(`${API}/customers/00000000-0000-0000-0000-000000000000/statement`, { headers });
    expect(missing.status()).toBe(404);
    const junk = await request.get(`${API}/customers/not-a-shop/statement`, { headers });
    expect(junk.status()).toBe(404);
    const reversed = await request.get(`${API}/customers/${customer.id}/statement?from=2026-10-02&to=2026-10-01`, { headers });
    expect((await reversed.json()).error.code).toBe('DATE_RANGE_REVERSED');

    // A walk-in sale, so the walk-in record exists; it has no account to state.
    const { product } = await stockedProduct(request, headers, mk, `Inv Statement Walk-in ${Date.now()}`, 2);
    const walkIn = await mk('sales/orders', {
      walkIn: true, currency: 'EGP', items: [{ productId: product.id, quantity: 1, unitPrice: 300, discount: 0 }],
    });
    const none = await request.get(`${API}/customers/${walkIn.customerId}/statement`, { headers });
    expect(none.status()).toBe(400);
    expect((await none.json()).error.code).toBe('WALK_IN_NO_STATEMENT');
  });
});

test.describe('Returning part of an order leaves the rest owed (§5 — found 2026-10-11)', () => {
  test('TC-INV-29: one of two units back on credit note — the order is not RETURNED and the shop still owes the other', async ({ request }) => {
    const { headers, mk } = await apiCtx(request);
    const stamp = Date.now();
    const { product } = await stockedProduct(request, headers, mk, `Inv Half Back ${stamp}`, 10);
    const customer = await mk('customers', { displayName: `Inv Half Back Shop ${stamp}`, type: 'B2B' });
    const order = await mk('sales/orders', {
      customerId: customer.id, channel: 'B2B', currency: 'EGP', confirm: true,
      items: [{ productId: product.id, quantity: 2, unitPrice: 1000, discount: 0 }],
    });
    const item = (await (await request.get(`${API}/sales/orders/${order.id}`, { headers })).json()).data.items[0];
    await mk('returns', { saleOrderId: order.id, reason: 'one came back', refundMethod: 'CREDIT_NOTE', items: [{ saleItemId: item.id, qty: 1 }] });

    const after = (await (await request.get(`${API}/sales/orders/${order.id}`, { headers })).json()).data;
    expect(after.status).not.toBe('RETURNED');
    expect(Number(after.outstanding)).toBe(1000);
    const shop = (await (await request.get(`${API}/customers/${customer.id}`, { headers })).json()).data;
    expect(Number(shop.outstandingBalance)).toBe(1000);

    // The second unit back is the whole order: now it is RETURNED, owing nothing.
    await mk('returns', { saleOrderId: order.id, reason: 'and the other', refundMethod: 'CREDIT_NOTE', items: [{ saleItemId: item.id, qty: 1 }] });
    const done = (await (await request.get(`${API}/sales/orders/${order.id}`, { headers })).json()).data;
    expect(done.status).toBe('RETURNED');
    const cleared = (await (await request.get(`${API}/customers/${customer.id}`, { headers })).json()).data;
    expect(Number(cleared.outstandingBalance)).toBe(0);
  });
});

/**
 * Two cycles, both selling, hold one product at different landed costs; one
 * sale takes more than the older batch has left (§3 FIFO, §8 cycle profit —
 * asked by the owner 2026-10-11). Built the way the business builds stock
 * (CLAUDE.md §4): cycle → purchase order → leg → delivery → receipt, for a
 * fresh product, received one after the other on different arrival days.
 */
test.describe('One sale across two cycles: FIFO, each batch at its own cost (§3, §8 — 2026-10-11)', () => {
  const daysAgoIso = (n: number) => dayFromNow(-n);

  /** A UAE-direct cycle of `qty` units of `productId` landing at exactly `unit` EGP, received into stock now. */
  async function cycleReceived(
    request: APIRequestContext,
    headers: any,
    mk: (path: string, data: any) => Promise<any>,
    productId: string,
    unit: number,
    qty: number,
    arrivedDaysAgo: number,
  ) {
    const supplier = await mk('suppliers', { name: `FIFO Sup ${Date.now()}${unit}`, country: 'AE' });
    const cycle = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'EGP' });
    // A cycle starts with its partners at zero; one puts the money in, so
    // settlement has a basis to split on (§10 — no basis, no split).
    const seeded = (await (await request.get(`${API}/cycles/${cycle.id}`, { headers })).json()).data.participants;
    const funded = await request.put(`${API}/cycles/participants/${seeded[0].id}`, {
      headers, data: { contributionAmount: unit * qty },
    });
    expect(funded.ok(), await funded.text()).toBeTruthy();
    await mk(`cycles/${cycle.id}/purchases`, {
      supplierId: supplier.id, currency: 'EGP', fxRateToEgp: 1, orderedOn: daysAgoIso(30),
      items: [{ productId, orderedQty: qty, unitPrice: unit }],
    });
    // Free freight, so a unit lands at exactly what it cost.
    const leg = await mk(`cycles/${cycle.id}/shipping-legs`, {
      sequence: 1, origin: 'Dubai, UAE', destination: 'Cairo, Egypt',
      provider: 'FIFO Freight', costBasis: 'FLAT', amount: 0, currency: 'EGP', fxRateToEgp: 1,
      departedOn: daysAgoIso(arrivedDaysAgo + 10),
    });
    const full = (await (await request.get(`${API}/cycles/${cycle.id}`, { headers })).json()).data;
    const item = full.purchaseOrders[0].items[0];
    for (const status of ['FUNDING', 'PURCHASING', 'ARRIVED_UAE', 'IN_TRANSIT_TO_EGYPT']) {
      await mk(`cycles/${cycle.id}/transition`, { status });
    }
    const delivery = await mk(`shipping/legs/${leg.id}/deliveries`, {
      arrivedOn: daysAgoIso(arrivedDaysAgo), lines: [{ purchaseOrderItemId: item.id, qty }],
    });
    await mk(`cycles/${cycle.id}/transition`, { status: 'ARRIVED_EGYPT' });
    await mk('receipts/verify', {
      cycleId: cycle.id, deliveryId: delivery.id,
      items: [{ deliveryLineId: delivery.lines[0].id, receivedQty: qty }],
    });
    const after = (await (await request.get(`${API}/cycles/${cycle.id}`, { headers })).json()).data;
    expect(after.status, 'the first receipt puts the cycle on sale').toBe('SELLING');
    return cycle;
  }

  async function batches(request: APIRequestContext, headers: any, productId: string) {
    const body = await (await request.get(`${API}/inventory?productId=${productId}`, { headers })).json();
    const row = (body.data ?? []).find((p: any) => p.productId === productId);
    return new Map<string, any>((row?.batches ?? []).map((b: any) => [b.cycleId, b]));
  }

  async function profitOf(request: APIRequestContext, headers: any, cycleId: string) {
    const all = (await (await request.get(`${API}/analytics/cycle-profitability`, { headers })).json()).data;
    return all.find((c: any) => c.cycleId === cycleId);
  }

  test('TC-INV-30: 3 sold with 2 left in the older batch — 2 at 900 then 1 at 1,100; each cycle counts only its own units; cancel and return give each batch its own back', async ({ request }) => {
    const { headers, mk } = await apiCtx(request);
    const product = await mk('products', { name: `FIFO Helmet ${Date.now()}`, minStock: 0 });
    const older = await cycleReceived(request, headers, mk, product.id, 900, 2, 12);
    const newer = await cycleReceived(request, headers, mk, product.id, 1100, 5, 4);
    const customer = await mk('customers', { displayName: `FIFO Shop ${Date.now()}`, type: 'B2B' });

    const sale = await mk('sales/orders', {
      customerId: customer.id, channel: 'B2B', currency: 'EGP', confirm: true,
      items: [{ productId: product.id, quantity: 3, unitPrice: 1500, discount: 0 }],
    });
    const detail = (await (await request.get(`${API}/sales/orders/${sale.id}`, { headers })).json()).data;
    const allocs = detail.items[0].allocations;
    const b = await batches(request, headers, product.id);
    const olderBatch = b.get(older.id);
    const newerBatch = b.get(newer.id);

    // The older-received batch is drawn first and emptied; the rest from the newer.
    expect(allocs).toHaveLength(2);
    const fromOlder = allocs.find((a: any) => a.inventoryBatchId === olderBatch.id);
    const fromNewer = allocs.find((a: any) => a.inventoryBatchId === newerBatch.id);
    expect([Number(fromOlder.qty), Number(fromOlder.unitCostEgp), Number(fromOlder.cogsEgp)]).toEqual([2, 900, 1800]);
    expect([Number(fromNewer.qty), Number(fromNewer.unitCostEgp), Number(fromNewer.cogsEgp)]).toEqual([1, 1100, 1100]);
    expect(Number(olderBatch.remainingQty)).toBe(0);
    expect(Number(newerBatch.remainingQty)).toBe(4);

    // Revenue follows each allocation: 2 × 1,500 to the older cycle, 1 × 1,500 to the newer.
    const pOlder = await profitOf(request, headers, older.id);
    const pNewer = await profitOf(request, headers, newer.id);
    expect([pOlder.totalRevenue, pOlder.totalCost, pOlder.profit, pOlder.unitsSold]).toEqual([3000, 1800, 1200, 2]);
    expect([pNewer.totalRevenue, pNewer.totalCost, pNewer.profit, pNewer.unitsSold]).toEqual([1500, 1100, 400, 1]);
    // The two add up to the sale's own profit: 4,500 − 2,900.
    expect(pOlder.profit + pNewer.profit).toBe(4500 - 2900);

    // Settlement sees the same split.
    const preview = async (cycleId: string) =>
      (await (await request.get(`${API}/settlements/preview/${cycleId}`, { headers })).json()).data;
    const sOlder = await preview(older.id);
    const sNewer = await preview(newer.id);
    expect([Number(sOlder.revenueEgp), Number(sOlder.cogsEgp)]).toEqual([3000, 1800]);
    expect([Number(sNewer.revenueEgp), Number(sNewer.cogsEgp)]).toEqual([1500, 1100]);
    expect(Number(sOlder.grossProfitEgp) + Number(sNewer.grossProfitEgp)).toBeCloseTo(
      3000 - 1800 - Number(sOlder.expensesEgp) + 1500 - 1100 - Number(sNewer.expensesEgp), 2,
    );

    // A third, cheaper batch arriving later re-prices nothing already sold.
    const third = await cycleReceived(request, headers, mk, product.id, 700, 5, 1);
    const again = (await (await request.get(`${API}/sales/orders/${sale.id}`, { headers })).json()).data.items[0].allocations;
    expect(again.map((a: any) => Number(a.cogsEgp)).sort()).toEqual([1100, 1800]);
    expect((await profitOf(request, headers, older.id)).totalCost).toBe(1800);
    expect((await profitOf(request, headers, third.id)).unitsSold).toBe(0);

    // Every unit back, on credit: each batch gets its own back, and nothing moves to the third.
    const line = detail.items[0];
    await mk('returns', { saleOrderId: sale.id, reason: 'all three back', refundMethod: 'CREDIT_NOTE', items: [{ saleItemId: line.id, qty: 3 }] });
    let now = await batches(request, headers, product.id);
    expect([now.get(older.id).remainingQty, now.get(newer.id).remainingQty, now.get(third.id).remainingQty].map(Number)).toEqual([2, 5, 5]);

    // The same sale again then cancelled: the older batch first again, and each gets its own back.
    const second = await mk('sales/orders', {
      customerId: customer.id, channel: 'B2B', currency: 'EGP', confirm: true,
      items: [{ productId: product.id, quantity: 3, unitPrice: 1500, discount: 0 }],
    });
    now = await batches(request, headers, product.id);
    expect([now.get(older.id).remainingQty, now.get(newer.id).remainingQty, now.get(third.id).remainingQty].map(Number)).toEqual([0, 4, 5]);
    await mk(`sales/orders/${second.id}/cancel`, {});
    now = await batches(request, headers, product.id);
    expect([now.get(older.id).remainingQty, now.get(newer.id).remainingQty, now.get(third.id).remainingQty].map(Number)).toEqual([2, 5, 5]);
  });
});

test.describe('A payment is reversed once (§7 — found 2026-10-11)', () => {
  test('TC-INV-31: reversing the same payment twice — the second is refused, and the order owes what it owed after the first', async ({ request }) => {
    const { headers, mk } = await apiCtx(request);
    const stamp = Date.now();
    const { product } = await stockedProduct(request, headers, mk, `Inv Reverse ${stamp}`, 5);
    const customer = await mk('customers', { displayName: `Inv Reverse Shop ${stamp}`, type: 'B2B' });
    const order = await owedOrder(mk, customer.id, product.id, 1000);
    const payment = await mk('payments', { customerId: customer.id, amount: 400, currency: 'EGP', orderId: order.id });
    expect(await outstandingOf(request, headers, order.id)).toBe(600);

    await mk(`payments/${payment.id}/reverse`, { reason: 'cheque bounced' });
    expect(await outstandingOf(request, headers, order.id)).toBe(1000);

    const again = await request.post(`${API}/payments/${payment.id}/reverse`, { headers, data: { reason: 'clicked twice' } });
    expect(again.status()).toBe(400);
    expect((await again.json()).error?.code).toBe('PAYMENT_ALREADY_REVERSED');
    // Never more than the order is worth.
    expect(await outstandingOf(request, headers, order.id)).toBe(1000);
  });
});

// ─── A purchase paid by a friend (§18 — L1, 2026-10-11) ─────────────────

/**
 * An order of 30,000 AED at 13.00 (390,000 EGP) and 13,000 EGP of freight,
 * every unit received — so the only thing between the cycle and settlement is
 * whatever a friend is still owed. Built the business's way (rule 4).
 */
async function friendCycle(request: APIRequestContext, label: string) {
  const { headers, mk } = await apiCtx(request);
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const product = await mk('products', { name: `${label} ${stamp} Part`, minStock: 0 });
  const supplier = await mk('suppliers', { name: `${label} ${stamp} Supplier`, country: 'AE' });
  const cycle = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'AED' });
  const po = await mk(`cycles/${cycle.id}/purchases`, {
    supplierId: supplier.id, currency: 'AED', fxRateToEgp: 13, orderedOn: dayFromNow(-30),
    items: [{ productId: product.id, orderedQty: 100, unitPrice: 300 }],
  });
  await mk(`cycles/${cycle.id}/shipping-legs`, {
    sequence: 1, origin: 'Dubai, UAE', destination: 'Cairo, Egypt',
    costBasis: 'FLAT', amount: 13000, currency: 'EGP', fxRateToEgp: 1,
    departedOn: dayFromNow(-20), arrivedOn: dayFromNow(-10),
  });
  for (const status of ['FUNDING', 'PURCHASING', 'ARRIVED_UAE', 'IN_TRANSIT_TO_EGYPT', 'ARRIVED_EGYPT', 'VERIFICATION']) {
    await mk(`cycles/${cycle.id}/transition`, { status });
  }
  const full = await (await request.get(`${API}/cycles/${cycle.id}`, { headers })).json();
  const item = (full.data ?? full).purchaseOrders[0].items[0];
  await mk('receipts/verify', {
    cycleId: cycle.id,
    items: [{ purchaseOrderItemId: item.id, productId: product.id, receivedQty: 100 }],
  });
  // The partners fund the freight, the friend the goods (§18 "Split equally").
  const partners = ((full.data ?? full).participants as any[]).filter((p) => p.participantType === 'CORE_PARTNER');
  for (const [i, p] of partners.entries()) {
    const share = i === partners.length - 1 ? 13000 - 4333.33 * (partners.length - 1) : 4333.33;
    const res = await request.put(`${API}/cycles/participants/${p.id}`, { headers, data: { contributionAmount: share } });
    expect(res.ok(), await res.text()).toBeTruthy();
  }
  const accounts = (await (await request.get(`${API}/ledger/accounts`, { headers })).json()).data;
  const account = accounts.find((a: any) => a.currency === 'EGP');
  const lender = await mk('lenders', { name: `${label} Friend ${stamp}` });
  return { headers, mk, cycle, po, lender, account, stamp };
}

const codeOf = async (res: any) => (await res.json()).error?.code;

test.describe('A purchase paid by a friend, repaid in pounds (§18 — L1)', () => {
  test('TC-INV-32: nothing clears more than is owed, and every way of doing too much, twice or in the wrong place is refused with a code', async ({ request }) => {
    const { headers, mk, cycle, po, lender, account, stamp } = await friendCycle(request, 'Inv L1');
    const post = (path: string, data: any) => request.post(`${API}/${path}`, { headers, data });

    // More than the order, alone or across two friends.
    expect(await codeOf(await post(`purchases/${po.id}/financings`, { lenderId: lender.id, amount: 30000.01 }))).toBe('FINANCING_EXCEEDS_ORDER');
    const f = await mk(`purchases/${po.id}/financings`, { lenderId: lender.id, amount: 20000 });
    const second = await mk('lenders', { name: `Inv L1 Second ${stamp}` });
    expect(await codeOf(await post(`purchases/${po.id}/financings`, { lenderId: second.id, amount: 10000.01 }))).toBe('FINANCING_EXCEEDS_ORDER');
    // The same friend twice on one order.
    expect(await codeOf(await post(`purchases/${po.id}/financings`, { lenderId: lender.id, amount: 1 }))).toBe('LENDER_ALREADY_FINANCES_ORDER');
    // Zero, negative, a date that has not come.
    expect((await post(`purchases/${po.id}/financings`, { lenderId: second.id, amount: 0 })).status()).toBe(400);
    expect(await codeOf(await post(`purchases/${po.id}/financings`, { lenderId: second.id, amount: 5, paidOn: dayFromNow(3) }))).toBe('DATE_IN_FUTURE');
    // Things that do not exist: a clear 404, never a 500.
    for (const [path, data] of [
      [`purchases/00000000-0000-4000-8000-00000000dead/financings`, { lenderId: lender.id, amount: 5 }],
      [`purchases/${po.id}/financings`, { lenderId: '00000000-0000-4000-8000-00000000dead', amount: 5 }],
      [`lender-financings/not-a-uuid/repayments`, { amountEgp: 5, rateToEgp: 13, accountId: account.id }],
      [`lender-repayments/00000000-0000-4000-8000-00000000dead/reverse`, { reason: 'nothing there' }],
    ] as const) {
      const res = await post(path, data);
      expect([path, res.status()]).toEqual([path, 404]);
      expect(await codeOf(res)).toBe('NOT_FOUND');
    }

    // Repayments: a rate of zero, one piastre past the payoff, a day in the future or before he paid.
    const pay = (data: any) => post(`lender-financings/${f.id}/repayments`, { accountId: account.id, ...data });
    expect(await codeOf(await pay({ amountEgp: 100, rateToEgp: 0 }))).toBe('RATE_NOT_POSITIVE');
    const quote = (await (await request.get(`${API}/lender-financings/${f.id}/quote?rateToEgp=13.7`, { headers })).json()).data;
    expect(quote.settlingEgp).toBe('274000.00');
    expect(await codeOf(await pay({ amountEgp: 274000.01, rateToEgp: 13.7 }))).toBe('LENDER_REPAYMENT_EXCEEDS_OWED');
    expect(await codeOf(await pay({ amountEgp: 0.05, rateToEgp: 13.7 }))).toBe('LENDER_REPAYMENT_CLEARS_NOTHING');
    expect(await codeOf(await pay({ amountEgp: 100, rateToEgp: 13.7, paidOn: dayFromNow(2) }))).toBe('DATE_IN_FUTURE');
    const early = await mk(`purchases/${po.id}/financings`, { lenderId: second.id, amount: 100, paidOn: dayFromNow(-1) });
    expect(await codeOf(await post(`lender-financings/${early.id}/repayments`, { accountId: account.id, amountEgp: 100, rateToEgp: 13, paidOn: dayFromNow(-2) }))).toBe('LENDER_REPAYMENT_BEFORE_FINANCING');

    // Paid off exactly, then nothing more.
    const done = await mk(`lender-financings/${f.id}/repayments`, { accountId: account.id, amountEgp: 274000, rateToEgp: 13.7 });
    expect(done.owed).toBe('0.00');
    expect(await codeOf(await pay({ amountEgp: 1, rateToEgp: 13.7 }))).toBe('LENDER_REPAYMENT_EXCEEDS_OWED');

    // The second time: reversing twice, removing after a repayment.
    const rid = done.repayments[0].id;
    await mk(`lender-repayments/${rid}/reverse`, { reason: 'wrong day' });
    expect(await codeOf(await post(`lender-repayments/${rid}/reverse`, { reason: 'again' }))).toBe('LENDER_REPAYMENT_ALREADY_REVERSED');
    await mk(`lender-financings/${f.id}/repayments`, { accountId: account.id, amountEgp: 1300, rateToEgp: 13 });
    expect(await codeOf(await post(`lender-financings/${f.id}/remove`, { reason: 'mistake' }))).toBe('FINANCING_HAS_REPAYMENTS');
    // A reason is required for every undo.
    expect((await post(`lender-financings/${early.id}/remove`, { reason: '   ' })).status()).toBe(400);

    // The wrong context: a cycle with a friend's payment cannot be cancelled;
    // a cancelled cycle takes none.
    const { mk: mk2 } = await apiCtx(request);
    const other = await mk2('cycles', { originType: 'UAE_DIRECT', currency: 'AED' });
    const product = await mk2('products', { name: `Inv L1 Cancel ${stamp}`, minStock: 0 });
    const supplier = await mk2('suppliers', { name: `Inv L1 Cancel Sup ${stamp}`, country: 'AE' });
    const otherPo = await mk2(`cycles/${other.id}/purchases`, {
      supplierId: supplier.id, currency: 'AED', fxRateToEgp: 13, orderedOn: dayFromNow(-1),
      items: [{ productId: product.id, orderedQty: 1, unitPrice: 100 }],
    });
    const otherF = await mk2(`purchases/${otherPo.id}/financings`, { lenderId: lender.id, amount: 100 });
    expect(await codeOf(await post(`cycles/${other.id}/transition`, { status: 'CANCELLED' }))).toBe('CYCLE_HAS_LENDER_FINANCING');
    await mk2(`lender-financings/${otherF.id}/remove`, { reason: 'friend did not pay after all' });
    expect(await codeOf(await post(`lender-financings/${otherF.id}/remove`, { reason: 'twice' }))).toBe('FINANCING_REMOVED');
    await mk2(`cycles/${other.id}/transition`, { status: 'CANCELLED' });
    expect(await codeOf(await post(`purchases/${otherPo.id}/financings`, { lenderId: second.id, amount: 1 }))).toBe('CYCLE_CLOSED_FOR_FINANCING');
    void cycle;
  });

  test('TC-INV-33: cash out is the pounds actually paid — repayments out, reversals back, the friend\'s payment in at the order rate', async ({ request }) => {
    const { headers, mk, cycle, po, lender, account } = await friendCycle(request, 'Inv L1 Cash');
    const f = await mk(`purchases/${po.id}/financings`, { lenderId: lender.id, amount: 30000 });
    const r1 = await mk(`lender-financings/${f.id}/repayments`, { accountId: account.id, amountEgp: 137000, rateToEgp: 13.7 });
    const r2 = await mk(`lender-financings/${f.id}/repayments`, { accountId: account.id, amountEgp: 125555.55, rateToEgp: 12.5555 });
    await mk(`lender-repayments/${r2.repayments[1].id}/reverse`, { reason: 'bounced' });
    const r3 = await mk(`lender-financings/${f.id}/repayments`, { accountId: account.id, amountEgp: 100000, rateToEgp: 12.5 });
    void r1;

    const rows: any[] = (await (await request.get(`${API}/ledger?cycleId=${cycle.id}&limit=200`, { headers })).json()).data;
    const net = (category: string) =>
      rows
        .filter((r) => r.category === category)
        .reduce((s, r) => s + (r.direction === 'INFLOW' ? 1 : -1) * Number(r.amount), 0);
    // 137,000 + 100,000 left the accounts; the reversed 125,555.55 came back.
    const standing = r3.repayments.filter((r: any) => !r.reversedAt).reduce((s: number, r: any) => s + Number(r.amountEgp), 0);
    expect(standing).toBeCloseTo(237000, 2);
    expect(net('lender_repayment')).toBeCloseTo(-237000, 2);
    // His money paying our supplier is in, once, at the order's rate.
    expect(net('lender_financing')).toBeCloseTo(390000, 2);
    // Each repayment row is the account the pounds left.
    expect(rows.filter((r) => r.category === 'lender_repayment').every((r) => r.account?.id === account.id || r.accountId === account.id)).toBeTruthy();
  });

  test('TC-INV-34: the exchange difference is cycle profit — settlement, the cycle\'s figure and the dashboard agree, and it is not an operating expense', async ({ request }) => {
    const { headers, mk, cycle, po, lender, account } = await friendCycle(request, 'Inv L1 Profit');
    const dash = async () => (await (await request.get(`${API}/analytics/dashboard`, { headers })).json()).data;
    const before = await dash();

    const f = await mk(`purchases/${po.id}/financings`, { lenderId: lender.id, amount: 30000 });
    // Up (+7,000) then down (-1,000 on 10,000 at 12.9): +6,000 net so far.
    await mk(`lender-financings/${f.id}/repayments`, { accountId: account.id, amountEgp: 137000, rateToEgp: 13.7 });
    await mk(`lender-financings/${f.id}/repayments`, { accountId: account.id, amountEgp: 129000, rateToEgp: 12.9 });
    const view = (await (await request.get(`${API}/purchases/${po.id}/financings`, { headers })).json()).data.financings[0];
    expect(view.exchangeDiffEgp).toBe('6000.00');

    const after = await dash();
    expect(after.netProfit).toBeCloseTo(before.netProfit - 6000, 2);
    expect(after.exchangeDifferenceEgp).toBeCloseTo((before.exchangeDifferenceEgp ?? 0) + 6000, 2);
    // Not an operating expense: totalExpenses does not move.
    expect(after.totalExpenses).toBeCloseTo(before.totalExpenses, 2);

    const preview = (await (await request.get(`${API}/settlements/preview/${cycle.id}`, { headers })).json()).data;
    expect(preview.exchangeDifferenceEgp).toBe('6000.00');
    expect(Number(preview.grossProfitEgp)).toBeCloseTo(-6000, 2);
    const profitability: any[] = (await (await request.get(`${API}/analytics/cycle-profitability`, { headers })).json()).data;
    const mine = profitability.find((c) => c.cycleId === cycle.id);
    expect(mine.exchangeDifferenceEgp).toBe(6000);
    expect(mine.profit).toBeCloseTo(Number(preview.grossProfitEgp), 2);
    // "Investment" is what the cycle consumed: goods and freight once, plus
    // the exchange difference — never the goods again through the repayments.
    expect(mine.investment).toBeCloseTo(403000 + 6000, 2);

    // A dirham that fell is a gain: 10,000 at 12 costs 120,000 for 130,000 of debt.
    await mk(`lender-financings/${f.id}/repayments`, { accountId: account.id, amountEgp: 120000, rateToEgp: 12 });
    const last = (await (await request.get(`${API}/settlements/preview/${cycle.id}`, { headers })).json()).data;
    expect(last.exchangeDifferenceEgp).toBe('-4000.00');
    expect((await dash()).netProfit).toBeCloseTo(before.netProfit + 4000, 2);
  });

  test('TC-INV-35: a cycle cannot settle while a friend is owed — by the plain transition or by approving — and can once he is repaid', async ({ request }) => {
    const { headers, mk, cycle, po, lender, account } = await friendCycle(request, 'Inv L1 Gate');
    const f = await mk(`purchases/${po.id}/financings`, { lenderId: lender.id, amount: 30000 });
    await mk(`lender-financings/${f.id}/repayments`, { accountId: account.id, amountEgp: 260000, rateToEgp: 13 });

    const t = await request.post(`${API}/cycles/${cycle.id}/transition`, { headers, data: { status: 'SETTLEMENT' } });
    expect(t.status()).toBe(400);
    const body = (await t.json()).error;
    expect(body.code).toBe('LENDER_DEBT_OUTSTANDING');
    expect(body.params.owed).toBe(`${lender.name} 10,000.00 AED`);

    const draft = (await mk(`settlements/calculate/${cycle.id}`, {}));
    const approve = await request.post(`${API}/settlements/${draft.id}/approve`, { headers, data: {} });
    expect(approve.status()).toBe(400);
    expect(await codeOf(approve)).toBe('LENDER_DEBT_OUTSTANDING');

    await mk(`lender-financings/${f.id}/repayments`, { accountId: account.id, amountEgp: 130000, rateToEgp: 13 });
    const ok = await request.post(`${API}/settlements/${draft.id}/approve`, { headers, data: {} });
    expect(ok.status(), await ok.text()).toBe(201);
    // Settled: a repayment on it cannot now be undone underneath the partners.
    const view = (await (await request.get(`${API}/purchases/${po.id}/financings`, { headers })).json()).data.financings[0];
    const undo = await request.post(`${API}/lender-repayments/${view.repayments[0].id}/reverse`, { headers, data: { reason: 'late change' } });
    expect(await codeOf(undo)).toBe('LENDER_CYCLE_SETTLED');
  });

  test('TC-INV-36: a friend\'s overdue instalment tells every partner once, by the existing morning job', async ({ request }) => {
    const { headers, mk, po, lender } = await friendCycle(request, 'Inv L1 Late');
    const f = await mk(`purchases/${po.id}/financings`, { lenderId: lender.id, amount: 30000 });
    // A plan cannot promise more than is owed.
    const tooMuch = await request.post(`${API}/lender-financings/${f.id}/plan`, {
      headers, data: { instalments: [{ dueOn: dayFromNow(10), amount: 30000.01 }] },
    });
    expect(await codeOf(tooMuch)).toBe('LENDER_PLAN_EXCEEDS_OWED');
    await mk(`lender-financings/${f.id}/plan`, {
      agreedOn: dayFromNow(-10),
      instalments: [{ dueOn: dayFromNow(-2), amount: 10000 }, { dueOn: dayFromNow(30), amount: 20000 }],
    });
    const again = await request.post(`${API}/lender-financings/${f.id}/plan`, {
      headers, data: { instalments: [{ dueOn: dayFromNow(10), amount: 1 }] },
    });
    expect(await codeOf(again)).toBe('LENDER_PLAN_EXISTS');

    const cron = { Authorization: `Bearer ${process.env.CRON_SECRET ?? 'local-cron-secret'}` };
    for (let i = 0; i < 2; i++) {
      const run = await request.get(`${API}/jobs/overdue-payments`, { headers: cron });
      expect(run.status(), await run.text()).toBe(200);
    }
    for (const email of ['partner.a@motoparts.com', 'partner.b@motoparts.com', 'partner.c@motoparts.com']) {
      const login = await request.post(`${API}/auth/login`, { data: { email, password: PASSWORD } });
      const h = { Authorization: `Bearer ${(await login.json()).data.accessToken}` };
      const notes: any[] = (await (await request.get(`${API}/notifications?limit=100`, { headers: h })).json()).data ?? [];
      const mine = notes.filter((n) => n.eventType === 'LENDER_OVERDUE' && n.payloadJson?.financingId === f.id);
      expect([email, mine.length]).toEqual([email, 1]);
      expect(mine[0].code).toBe('LENDER_INSTALMENT_OVERDUE');
      expect(mine[0].params.amount).toBe('10,000.00');
    }
  });
});
