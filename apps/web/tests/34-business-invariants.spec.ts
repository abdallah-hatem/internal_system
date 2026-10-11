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
import { apiCtx, giveStock, stockedProduct, owedOrder, refusedCallers } from './support/fixtures';

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
