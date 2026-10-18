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
import { alreadyWalked, anInvestorUser, apiCtx, giveStock, stockedProduct, owedOrder, outstandingOf, refusedCallers } from './support/fixtures';
import { psqlQuery, psqlStdin } from './support/database';
import { leftoverWorld } from './support/leftovers';
import { approved, cents, recordCost, runningCosts, settlement, settlementRows, soldOutCycle, usersByEmail, waitingFor } from './support/running-costs';
import { API } from './support/env';

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
    // A step the shipment already walked the cycle through (L3) is skipped.
    const walked = await alreadyWalked(request, headers, path, data);
    if (walked) return walked;
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
      orderedOn: dayFromNow(-30),
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
      supplierId: supplier.id, currency: 'EGP', fxRateToEgp: 1, orderedOn: daysAgoIso(arrivedDaysAgo + 20),
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

  test('TC-INV-48: the below-cost check costs a sale at exactly the COGS confirming records — across batches, over two lines, with a discount (§4, L4)', async ({ request }) => {
    const { headers, mk } = await apiCtx(request);
    const product = await mk('products', { name: `Cost Check ${Date.now()}`, minStock: 0 });
    await cycleReceived(request, headers, mk, product.id, 900, 2, 12);
    await cycleReceived(request, headers, mk, product.id, 1100, 5, 4);
    const customer = await mk('customers', { displayName: `Cost Check Shop ${Date.now()}`, type: 'B2B' });
    const items = [
      { productId: product.id, quantity: 3, unitPrice: 950, discount: 0 },
      { productId: product.id, quantity: 2, unitPrice: 1200, discount: 250 },
    ];

    const check = await request.post(`${API}/sales/price-check`, { headers, data: { currency: 'EGP', items } });
    expect(check.ok(), await check.text()).toBeTruthy();
    const said = (await check.json()).data;
    // 2 × 900 + 1 × 1,100 = 2,900 against 2,850; then 2 × 1,100 = 2,200 against 2,150.
    expect(said.lines.map((l: any) => [l.costEgp, l.lossEgp])).toEqual([['2900.00', '50.00'], ['2200.00', '50.00']]);
    expect(said.totalLossEgp).toBe('100.00');

    // A warning, not a refusal: the same lines confirm.
    const sale = await mk('sales/orders', { customerId: customer.id, channel: 'B2B', currency: 'EGP', confirm: true, items });
    const detail = (await (await request.get(`${API}/sales/orders/${sale.id}`, { headers })).json()).data;
    const cogs = detail.items.map((i: any) =>
      (i.allocations ?? []).reduce((t: number, a: any) => t + Math.round(Number(a.cogsEgp) * 100), 0) / 100,
    );
    expect(cogs).toEqual(said.lines.map((l: any) => Number(l.costEgp)));
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
async function friendCycle(
  request: APIRequestContext,
  label: string,
  opts: { freight?: number; partnersFund?: boolean } = {},
) {
  const freight = opts.freight ?? 13000;
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
    costBasis: 'FLAT', amount: freight, currency: 'EGP', fxRateToEgp: 1,
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
  for (const [i, p] of (opts.partnersFund === false ? [] : partners).entries()) {
    const share = i === partners.length - 1 ? 13000 - 4333.33 * (partners.length - 1) : 4333.33;
    const res = await request.put(`${API}/cycles/participants/${p.id}`, { headers, data: { contributionAmount: share } });
    expect(res.ok(), await res.text()).toBeTruthy();
  }
  const lender = await mk('lenders', { name: `${label} Friend ${stamp}` });
  return { headers, mk, cycle, po, lender, stamp, product, partners };
}

const codeOf = async (res: any) => (await res.json()).error?.code;

test.describe('A purchase paid by a friend, repaid in pounds (§18 — L1)', () => {
  test('TC-INV-32: nothing clears more than is owed, and every way of doing too much, twice or in the wrong place is refused with a code', async ({ request }) => {
    const { headers, mk, cycle, po, lender, stamp } = await friendCycle(request, 'Inv L1');
    const post = (path: string, data: any) => request.post(`${API}/${path}`, { headers, data });

    // More than the cycle's cost — 390,000 of goods + 13,000 of freight =
    // 403,000 EGP, 31,000 AED at 13 (§18, 2026-10-16) — alone or across two friends.
    expect(await codeOf(await post(`purchases/${po.id}/financings`, { lenderId: lender.id, amount: 31000.01 }))).toBe('FINANCING_EXCEEDS_CYCLE_COST');
    const f = await mk(`purchases/${po.id}/financings`, { lenderId: lender.id, amount: 20000 });
    const second = await mk('lenders', { name: `Inv L1 Second ${stamp}` });
    expect(await codeOf(await post(`purchases/${po.id}/financings`, { lenderId: second.id, amount: 11000.01 }))).toBe('FINANCING_EXCEEDS_CYCLE_COST');
    // The same friend twice on one order.
    expect(await codeOf(await post(`purchases/${po.id}/financings`, { lenderId: lender.id, amount: 1 }))).toBe('LENDER_ALREADY_FINANCES_ORDER');
    // Zero, negative, a date that has not come.
    expect((await post(`purchases/${po.id}/financings`, { lenderId: second.id, amount: 0 })).status()).toBe(400);
    expect(await codeOf(await post(`purchases/${po.id}/financings`, { lenderId: second.id, amount: 5, paidOn: dayFromNow(3) }))).toBe('DATE_IN_FUTURE');
    // Things that do not exist: a clear 404, never a 500.
    for (const [path, data] of [
      [`purchases/00000000-0000-4000-8000-00000000dead/financings`, { lenderId: lender.id, amount: 5 }],
      [`purchases/${po.id}/financings`, { lenderId: '00000000-0000-4000-8000-00000000dead', amount: 5 }],
      [`lender-financings/not-a-uuid/repayments`, { amountEgp: 5, rateToEgp: 13 }],
      [`lender-repayments/00000000-0000-4000-8000-00000000dead/reverse`, { reason: 'nothing there' }],
    ] as const) {
      const res = await post(path, data);
      expect([path, res.status()]).toEqual([path, 404]);
      expect(await codeOf(res)).toBe('NOT_FOUND');
    }

    // Repayments: a rate of zero, one piastre past the payoff, a day in the future or before he paid.
    const pay = (data: any) => post(`lender-financings/${f.id}/repayments`, { ...data });
    expect(await codeOf(await pay({ amountEgp: 100, rateToEgp: 0 }))).toBe('RATE_NOT_POSITIVE');
    const quote = (await (await request.get(`${API}/lender-financings/${f.id}/quote?rateToEgp=13.7`, { headers })).json()).data;
    expect(quote.settlingEgp).toBe('274000.00');
    expect(await codeOf(await pay({ amountEgp: 274000.01, rateToEgp: 13.7 }))).toBe('LENDER_REPAYMENT_EXCEEDS_OWED');
    expect(await codeOf(await pay({ amountEgp: 0.05, rateToEgp: 13.7 }))).toBe('LENDER_REPAYMENT_CLEARS_NOTHING');
    expect(await codeOf(await pay({ amountEgp: 100, rateToEgp: 13.7, paidOn: dayFromNow(2) }))).toBe('DATE_IN_FUTURE');
    const early = await mk(`purchases/${po.id}/financings`, { lenderId: second.id, amount: 100, paidOn: dayFromNow(-1) });
    expect(await codeOf(await post(`lender-financings/${early.id}/repayments`, { amountEgp: 100, rateToEgp: 13, paidOn: dayFromNow(-2) }))).toBe('LENDER_REPAYMENT_BEFORE_FINANCING');

    // Paid off exactly, then nothing more.
    const done = await mk(`lender-financings/${f.id}/repayments`, { amountEgp: 274000, rateToEgp: 13.7 });
    expect(done.owed).toBe('0.00');
    expect(await codeOf(await pay({ amountEgp: 1, rateToEgp: 13.7 }))).toBe('LENDER_REPAYMENT_EXCEEDS_OWED');

    // The second time: reversing twice, removing after a repayment.
    const rid = done.repayments[0].id;
    await mk(`lender-repayments/${rid}/reverse`, { reason: 'wrong day' });
    expect(await codeOf(await post(`lender-repayments/${rid}/reverse`, { reason: 'again' }))).toBe('LENDER_REPAYMENT_ALREADY_REVERSED');
    await mk(`lender-financings/${f.id}/repayments`, { amountEgp: 1300, rateToEgp: 13 });
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
    const { headers, mk, cycle, po, lender } = await friendCycle(request, 'Inv L1 Cash');
    const f = await mk(`purchases/${po.id}/financings`, { lenderId: lender.id, amount: 30000 });
    const r1 = await mk(`lender-financings/${f.id}/repayments`, { amountEgp: 137000, rateToEgp: 13.7 });
    const r2 = await mk(`lender-financings/${f.id}/repayments`, { amountEgp: 125555.55, rateToEgp: 12.5555 });
    await mk(`lender-repayments/${r2.repayments[1].id}/reverse`, { reason: 'bounced' });
    const r3 = await mk(`lender-financings/${f.id}/repayments`, { amountEgp: 100000, rateToEgp: 12.5 });
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
    // No account on any row: money accounts were removed (owner 2026-10-14).
    expect(rows.filter((r) => r.category === 'lender_repayment').every((r) => !('account' in r) && !('accountId' in r))).toBeTruthy();
  });

  test('TC-INV-34: the exchange difference is cycle profit — settlement, the cycle\'s figure and the dashboard agree, and it is not an operating expense', async ({ request }) => {
    const { headers, mk, cycle, po, lender } = await friendCycle(request, 'Inv L1 Profit');
    const dash = async () => (await (await request.get(`${API}/analytics/dashboard`, { headers })).json()).data;
    const before = await dash();

    const f = await mk(`purchases/${po.id}/financings`, { lenderId: lender.id, amount: 30000 });
    // Up (+7,000) then down (-1,000 on 10,000 at 12.9): +6,000 net so far.
    await mk(`lender-financings/${f.id}/repayments`, { amountEgp: 137000, rateToEgp: 13.7 });
    await mk(`lender-financings/${f.id}/repayments`, { amountEgp: 129000, rateToEgp: 12.9 });
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
    await mk(`lender-financings/${f.id}/repayments`, { amountEgp: 120000, rateToEgp: 12 });
    const last = (await (await request.get(`${API}/settlements/preview/${cycle.id}`, { headers })).json()).data;
    expect(last.exchangeDifferenceEgp).toBe('-4000.00');
    expect((await dash()).netProfit).toBeCloseTo(before.netProfit + 4000, 2);
  });

  test('TC-INV-35: a cycle cannot settle while a friend is owed — by the plain transition or by approving — and can once he is repaid', async ({ request }) => {
    const { headers, mk, cycle, po, lender } = await friendCycle(request, 'Inv L1 Gate');
    const f = await mk(`purchases/${po.id}/financings`, { lenderId: lender.id, amount: 30000 });
    await mk(`lender-financings/${f.id}/repayments`, { amountEgp: 260000, rateToEgp: 13 });

    const t = await request.post(`${API}/cycles/${cycle.id}/transition`, { headers, data: { status: 'SETTLEMENT' } });
    expect(t.status()).toBe(400);
    const body = (await t.json()).error;
    expect(body.code).toBe('LENDER_DEBT_OUTSTANDING');
    expect(body.params.owed).toBe(`${lender.name} 10,000.00 AED`);

    const draft = (await mk(`settlements/calculate/${cycle.id}`, {}));
    const approve = await request.post(`${API}/settlements/${draft.id}/approve`, { headers, data: {} });
    expect(approve.status()).toBe(400);
    expect(await codeOf(approve)).toBe('LENDER_DEBT_OUTSTANDING');

    await mk(`lender-financings/${f.id}/repayments`, { amountEgp: 130000, rateToEgp: 13 });
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

// ─── §18 edge cases named one by one (L1 review, 2026-10-11) ────────────

test.describe('A friend\'s loan: the cases the review asked to see refused (§18 — L1)', () => {
  test('TC-INV-37: financing an order that has no lines is refused', async ({ request }) => {
    const { headers, mk, lender } = await friendCycle(request, 'Inv L1 Empty');
    const stamp = Date.now();
    const cycle = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'AED' });
    const supplier = await mk('suppliers', { name: `Inv L1 Empty Sup ${stamp}`, country: 'AE' });
    // The API will not make one (PO_NEEDS_ITEM), but drafts with no lines
    // exist from before that rule (§15) — built here as such a row.
    const empty = { id: crypto.randomUUID() };
    psqlStdin(`
      INSERT INTO purchase_orders (id, cycle_id, supplier_id, reference, currency, fx_rate_to_egp, ordered_on, status, updated_at)
      VALUES ('${empty.id}', '${cycle.id}', '${supplier.id}', 'PO-EMPTY-${stamp}', 'AED', 13, CURRENT_DATE - 1, 'DRAFT', now());`);
    const res = await request.post(`${API}/purchases/${empty.id}/financings`, { headers, data: { lenderId: lender.id, amount: 100 } });
    expect(res.status()).toBe(400);
    expect(await codeOf(res)).toBe('FINANCING_ORDER_EMPTY');
  });

  // Owner 2026-10-14: "we don't need money accounts". The concept is gone, not
  // hidden: no endpoint lists them, a repayment cannot carry one, and neither a
  // repayment nor a ledger row has an account to show (§9, §18).
  test('TC-INV-38: money accounts are gone — /ledger/accounts is 404 and a repayment naming an account is refused as an unknown field', async ({ request }) => {
    const { headers, mk, cycle, po, lender } = await friendCycle(request, 'Inv L1 Acct');
    const listed = await request.get(`${API}/ledger/accounts`, { headers });
    expect(listed.status()).toBe(404);
    expect(await codeOf(listed)).toBe('NOT_FOUND');

    const f = await mk(`purchases/${po.id}/financings`, { lenderId: lender.id, amount: 1000 });
    const plain = await mk(`lender-financings/${f.id}/repayments`, { amountEgp: 130, rateToEgp: 13 });
    expect(plain.repayments[0]).not.toHaveProperty('account');
    const ledger: any[] = (await (await request.get(`${API}/ledger?cycleId=${cycle.id}&limit=200`, { headers })).json()).data;
    for (const row of ledger) {
      expect(row).not.toHaveProperty('account');
      expect(row).not.toHaveProperty('accountId');
    }

    // Any id at all — a well-formed one, the nil one — is an unknown field now,
    // refused before anything is written, never quietly dropped.
    for (const accountId of ['00000000-0000-4000-8000-0000000000d1', '00000000-0000-0000-0000-000000000000']) {
      const res = await request.post(`${API}/lender-financings/${f.id}/repayments`, {
        headers, data: { amountEgp: 1300, rateToEgp: 13, accountId },
      });
      expect([accountId, res.status()]).toEqual([accountId, 400]);
      const body = await res.json();
      expect(body.error.code).toBe('VALIDATION_FAILED');
      expect(body.error.params.fields).toBe('accountId');
      expect(body.error.message).toMatch(/accountId should not exist/);
    }
    const owed = (await (await request.get(`${API}/purchases/${po.id}/financings`, { headers })).json()).data.financings[0].owed;
    expect(owed).toBe('990.00');
  });

  test('TC-INV-39: repaying a financing that was removed is refused', async ({ request }) => {
    const { headers, mk, po, lender } = await friendCycle(request, 'Inv L1 Removed');
    const f = await mk(`purchases/${po.id}/financings`, { lenderId: lender.id, amount: 1000 });
    await mk(`lender-financings/${f.id}/remove`, { reason: 'recorded on the wrong order' });
    const res = await request.post(`${API}/lender-financings/${f.id}/repayments`, {
      headers, data: { amountEgp: 1300, rateToEgp: 13 },
    });
    expect(res.status()).toBe(400);
    expect(await codeOf(res)).toBe('FINANCING_REMOVED');
    const rows: any[] = (await (await request.get(`${API}/ledger?category=lender_repayment&limit=200`, { headers })).json()).data;
    expect(rows.filter((r) => r.relatedId && r.reason?.includes(lender.name))).toEqual([]);
  });

  test('TC-INV-40: reversing a repayment with a blank reason is refused', async ({ request }) => {
    const { headers, mk, po, lender } = await friendCycle(request, 'Inv L1 Reason');
    const f = await mk(`purchases/${po.id}/financings`, { lenderId: lender.id, amount: 1000 });
    const view = await mk(`lender-financings/${f.id}/repayments`, { amountEgp: 1300, rateToEgp: 13 });
    for (const reason of ['', '   ']) {
      const res = await request.post(`${API}/lender-repayments/${view.repayments[0].id}/reverse`, { headers, data: { reason } });
      expect([JSON.stringify(reason), res.status()]).toEqual([JSON.stringify(reason), 400]);
    }
    const after = (await (await request.get(`${API}/purchases/${po.id}/financings`, { headers })).json()).data.financings[0];
    expect(after.owed).toBe('900.00');
    expect(after.repayments[0].reversedAt).toBeNull();
  });

  test('TC-INV-41: a plan when nothing is owed is refused (LENDER_NOTHING_OWED)', async ({ request }) => {
    const { headers, mk, po, lender } = await friendCycle(request, 'Inv L1 Nothing');
    const f = await mk(`purchases/${po.id}/financings`, { lenderId: lender.id, amount: 1000 });
    await mk(`lender-financings/${f.id}/repayments`, { amountEgp: 13000, rateToEgp: 13 });
    const res = await request.post(`${API}/lender-financings/${f.id}/plan`, {
      headers, data: { instalments: [{ dueOn: dayFromNow(10), amount: 1 }] },
    });
    expect(res.status()).toBe(400);
    expect(await codeOf(res)).toBe('LENDER_NOTHING_OWED');
  });

  test('TC-INV-42: every write on a friend\'s loan refuses an investor (ROLE_NOT_ALLOWED) and a portal token (WRONG_SURFACE); a partner still may', async ({ request }) => {
    const { mk, po, lender } = await friendCycle(request, 'Inv L1 Roles');
    const f = await mk(`purchases/${po.id}/financings`, { lenderId: lender.id, amount: 1000 });
    const repaid = await mk(`lender-financings/${f.id}/repayments`, { amountEgp: 1300, rateToEgp: 13 });
    const planned = await mk(`lender-financings/${f.id}/plan`, { instalments: [{ dueOn: dayFromNow(10), amount: 100 }] });
    const writes: [string, Record<string, unknown>][] = [
      ['lenders', { name: 'Not allowed' }],
      [`purchases/${po.id}/financings`, { lenderId: lender.id, amount: 1 }],
      [`lender-financings/${f.id}/repayments`, { amountEgp: 13, rateToEgp: 13 }],
      [`lender-financings/${f.id}/remove`, { reason: 'not mine to remove' }],
      [`lender-repayments/${repaid.repayments[0].id}/reverse`, { reason: 'not mine to reverse' }],
      [`lender-financings/${f.id}/plan`, { instalments: [{ dueOn: dayFromNow(5), amount: 1 }] }],
      [`lender-plans/${planned.plan.id}/cancel`, { reason: 'not mine to cancel' }],
    ];
    const callers = await refusedCallers(request, 'l1roles');
    expect(callers.map((c) => c.code).sort()).toEqual(['ROLE_NOT_ALLOWED', 'WRONG_SURFACE']);
    for (const caller of callers) {
      for (const [path, data] of writes) {
        const res = await request.post(`${API}/${path}`, { headers: caller.headers, data });
        expect([caller.who, path, res.status()]).toEqual([caller.who, path, 403]);
        expect([caller.who, path, await codeOf(res)]).toEqual([caller.who, path, caller.code]);
      }
    }
    // Nothing moved, and the partner can still do each of them.
    await mk(`lender-plans/${planned.plan.id}/cancel`, { reason: 'agreed a new one' });
    await mk(`lender-repayments/${repaid.repayments[0].id}/reverse`, { reason: 'wrong day' });
    await mk(`lender-financings/${f.id}/plan`, { instalments: [{ dueOn: dayFromNow(5), amount: 1 }] });
    const gone = await mk(`lender-financings/${f.id}/remove`, { reason: 'recorded twice' });
    expect(gone.removedAt).not.toBeNull();
  });

  test('TC-INV-43: wrong owner — another friend\'s financing, or a plan id where a financing id belongs, is not found on these routes', async ({ request }) => {
    const { headers, mk, po, lender, stamp } = await friendCycle(request, 'Inv L1 Owner');
    const other = await mk('lenders', { name: `Inv L1 Owner Other ${stamp}` });
    const mine = await mk(`purchases/${po.id}/financings`, { lenderId: lender.id, amount: 1000 });
    const theirs = await mk(`purchases/${po.id}/financings`, { lenderId: other.id, amount: 500 });
    const planned = await mk(`lender-financings/${theirs.id}/plan`, { instalments: [{ dueOn: dayFromNow(10), amount: 100 }] });

    // A lender's page lists only what he paid: his friend's financing is not his.
    const page = (await (await request.get(`${API}/lenders/${lender.id}`, { headers })).json()).data;
    expect(page.financings.map((f: any) => f.id)).toEqual([mine.id]);
    // Every route is keyed by the financing (or plan, or repayment) itself, so
    // the lender is whoever that record names. An id of one kind used where
    // another belongs — a plan id on a financing route, a financing id on a
    // plan or repayment route — is not found, never quietly matched.
    const crossed: [string, Record<string, unknown>][] = [
      [`lender-financings/${planned.plan.id}/repayments`, { amountEgp: 13, rateToEgp: 13 }],
      [`lender-financings/${planned.plan.id}/plan`, { instalments: [{ dueOn: dayFromNow(5), amount: 1 }] }],
      [`lender-financings/${planned.plan.id}/remove`, { reason: 'crossed ids' }],
      [`lender-plans/${theirs.id}/cancel`, { reason: 'crossed ids' }],
      [`lender-plans/${mine.id}/cancel`, { reason: 'crossed ids' }],
      [`lender-repayments/${mine.id}/reverse`, { reason: 'crossed ids' }],
    ];
    for (const [path, data] of crossed) {
      const res = await request.post(`${API}/${path}`, { headers, data });
      expect([path, res.status()]).toEqual([path, 404]);
      expect(await codeOf(res)).toBe('NOT_FOUND');
    }
    const quote = await request.get(`${API}/lender-financings/${planned.plan.id}/quote?rateToEgp=13`, { headers });
    expect(quote.status()).toBe(404);
    // Their plan is untouched by any of it.
    const still = (await (await request.get(`${API}/lenders/${other.id}`, { headers })).json()).data.financings[0];
    expect(still.plan.id).toBe(planned.plan.id);
  });

  test('TC-INV-44: owed to lenders in a currency with no current rate is shown in that currency, left out of the pounds, and says so', async ({ request }) => {
    const { headers, mk, lender } = await friendCycle(request, 'Inv L1 NoRate');
    const before = (await (await request.get(`${API}/analytics/dashboard`, { headers })).json()).data.owedToLenders;
    // A currency no rate has ever been entered for.
    const cycle = await mk('cycles', { originType: 'CHINA', currency: 'HKD' });
    const supplier = await mk('suppliers', { name: `Inv L1 HK ${Date.now()}`, country: 'HK' });
    const product = await mk('products', { name: `Inv L1 HK part ${Date.now()}`, minStock: 0 });
    const po = await mk(`cycles/${cycle.id}/purchases`, {
      supplierId: supplier.id, currency: 'HKD', fxRateToEgp: 6.2, orderedOn: dayFromNow(-1),
      items: [{ productId: product.id, orderedQty: 10, unitPrice: 100 }],
    });
    await mk(`purchases/${po.id}/financings`, { lenderId: lender.id, amount: 1000 });

    const owed = (await (await request.get(`${API}/analytics/dashboard`, { headers })).json()).data.owedToLenders;
    const hkd = owed.lines.find((l: any) => l.currency === 'HKD');
    expect(before.lines.find((l: any) => l.currency === 'HKD')).toBeUndefined();
    expect(hkd).toEqual({ currency: 'HKD', owed: '1000.00', rateToEgp: null, owedEgp: null });
    expect(owed.missingRate).toBe(true);
    // Not counted as zero pounds, and not counted at the order's rate either.
    expect(Number(owed.totalEgp)).toBeCloseTo(Number(before.totalEgp), 2);
  });
});

// ─── A cycle a friend paid for entirely (owner decision 2026-10-11, §8 §18) ──

test.describe('A cycle a friend paid for entirely splits its profit equally among its partners (§8, §18 — L2)', () => {
  /**
   * 30,000 AED at 13.00 (390,000 EGP) paid by the friend, free freight, so the
   * partners are asked for nothing; the friend repaid at the order's own rate
   * (no exchange difference); all 100 sold for 480,000 — 90,000 of profit.
   */
  async function soldFriendCycle(request: APIRequestContext, label: string, freight: number) {
    const built = await friendCycle(request, label, { freight, partnersFund: false });
    const { mk, po, lender, product, stamp } = built;
    const f = await mk(`purchases/${po.id}/financings`, { lenderId: lender.id, amount: 30000 });
    await mk(`lender-financings/${f.id}/repayments`, { amountEgp: 390000, rateToEgp: 13 });
    const shop = await mk('customers', { displayName: `${label} Shop ${stamp}`, type: 'B2B' });
    await mk('sales/orders', {
      customerId: shop.id, channel: 'B2B', currency: 'EGP', confirm: true,
      items: [{ productId: product.id, quantity: 100, unitPrice: 4800, discount: 0 }],
    });
    return built;
  }

  test('TC-INV-45: 90,000 of profit, three partners who put in nothing and an investor on it — 30,000 each and nothing to him; preview, approve and the partners page agree', async ({ request }) => {
    const { headers, mk, cycle, stamp } = await soldFriendCycle(request, 'Inv L2 Whole', 0);
    const investor = await anInvestorUser(request, headers);
    await mk(`cycles/${cycle.id}/participants`, {
      participantType: 'TEMP_INVESTOR', investorUserId: investor.id, contributionAmount: 0, investorFeePct: 15,
    });
    const costing = (await (await request.get(`${API}/costing/cycles/${cycle.id}/landed-cost`, { headers })).json());
    expect([costing.totals.landedEgp, costing.totals.lenderFinancedEgp, costing.totals.toFundEgp]).toEqual(['390000.00', '390000.00', '0.00']);

    const participants: any[] = (await (await request.get(`${API}/cycles/${cycle.id}`, { headers })).json()).data.participants;
    const core = participants.filter((p) => p.participantType === 'CORE_PARTNER');
    const inv = participants.find((p) => p.participantType === 'TEMP_INVESTOR');
    expect(core).toHaveLength(3);
    expect(participants.every((p) => Number(p.contributionAmount) === 0)).toBeTruthy();

    // Preview.
    const pr = await request.get(`${API}/settlements/preview/${cycle.id}`, { headers });
    expect(pr.status(), await pr.text()).toBe(200);
    const preview = (await pr.json()).data;
    expect(preview.grossProfitEgp).toBe('90000.00');
    const line = (id: string) => preview.lines.find((l: any) => l.participantId === id);
    expect(core.map((p) => line(p.id).payoutEgp)).toEqual(['30000.00', '30000.00', '30000.00']);
    expect([line(inv.id).payoutEgp, line(inv.id).sharePct]).toEqual(['0.00', '0.0000']);

    // The partners page shows the same split before it settles.
    const participation: any[] = (await (await request.get(`${API}/users/participation`, { headers })).json()).data;
    const accruedOn = (userId: string) =>
      participation.find((u) => u.id === userId)?.cycles.find((c: any) => c.id === cycle.id)?.accruedProfitEgp;
    expect(core.map((p) => accruedOn(p.partnerUserId))).toEqual([30000, 30000, 30000]);
    // The cycle's own profit, as the dashboard reads it.
    const prof: any[] = (await (await request.get(`${API}/analytics/cycle-profitability`, { headers })).json()).data;
    expect(prof.find((c) => c.cycleId === cycle.id).profit).toBe(90000);

    // Calculate and approve: the same figures are settled.
    const draft = await mk(`settlements/calculate/${cycle.id}`, {});
    const ok = await request.post(`${API}/settlements/${draft.id}/approve`, { headers, data: {} });
    expect(ok.status(), await ok.text()).toBe(201);
    const settled = (await ok.json()).data;
    const profitOf = (pid: string) =>
      settled.lines.filter((l: any) => l.participantId === pid && l.component === 'PROFIT_SHARE').map((l: any) => Number(l.amount));
    expect(core.map((p) => profitOf(p.id))).toEqual([[30000], [30000], [30000]]);
    expect(profitOf(inv.id)).toEqual([0]);
    expect(settled.lines.filter((l: any) => l.component === 'INVESTOR_FEE')).toEqual([]);
    expect(stamp).toBeTruthy();
  });

  test('TC-INV-46: a cycle a friend paid for only partly, with nothing recorded from the partners, still refuses — preview and calculate alike', async ({ request }) => {
    const { headers, cycle } = await soldFriendCycle(request, 'Inv L2 Part', 13000);
    const costing = (await (await request.get(`${API}/costing/cycles/${cycle.id}/landed-cost`, { headers })).json());
    expect(costing.totals.toFundEgp).toBe('13000.00');
    const pr = await request.get(`${API}/settlements/preview/${cycle.id}`, { headers });
    expect(pr.status()).toBe(400);
    expect(await codeOf(pr)).toBe('CYCLE_NOT_FUNDED');
    const calc = await request.post(`${API}/settlements/calculate/${cycle.id}`, { headers, data: {} });
    expect(calc.status()).toBe(400);
    expect(await codeOf(calc)).toBe('CYCLE_NOT_FUNDED');
  });

  test('TC-INV-47: a custom split still overrides the equal one on a cycle a friend paid for entirely', async ({ request }) => {
    const { headers, cycle, partners } = await soldFriendCycle(request, 'Inv L2 Custom', 0);
    const pcts = [50, 30, 20];
    for (const [i, p] of partners.entries()) {
      const res = await request.put(`${API}/cycles/participants/${p.id}`, { headers, data: { customProfitPct: pcts[i] } });
      expect(res.ok(), await res.text()).toBeTruthy();
    }
    const preview = (await (await request.get(`${API}/settlements/preview/${cycle.id}`, { headers })).json()).data;
    expect(partners.map((p: any) => preview.lines.find((l: any) => l.participantId === p.id).payoutEgp)).toEqual(['45000.00', '27000.00', '18000.00']);
  });
});

// ─── L5: leftover stock moved to another cycle at its cost (§8) ──────────

test.describe('Leftovers moved between cycles (L5, §8)', () => {
  const dashboard = async (request: APIRequestContext, headers: any) =>
    (await (await request.get(`${API}/analytics/dashboard`, { headers })).json()).data;
  const preview = async (request: APIRequestContext, headers: any, id: string) =>
    (await (await request.get(`${API}/settlements/preview/${id}`, { headers })).json()).data;
  const profitability = async (request: APIRequestContext, headers: any, id: string) =>
    ((await (await request.get(`${API}/analytics/cycle-profitability`, { headers })).json()).data as any[]).find((c) => c.cycleId === id);

  test('TC-INV-51: value is conserved — what leaves A at cost is exactly what B funds and what each side of the ledger pair says; A’s profit does not move; five moves at once never take more than the shelf', async ({ request }) => {
    const { headers, a, b, pad } = await leftoverWorld(request, 'Inv L5 Conserve');
    const before = await preview(request, headers, a.id);
    expect(before.grossProfitEgp).toBe('1000.00'); // 10 × (200 − 100): not zero (§10)
    const fundB = async () => Number((await (await request.get(`${API}/costing/cycles/${b.id}/landed-cost`, { headers })).json()).totals.toFundEgp);
    const fundBefore = await fundB();

    // Five moves of 20 from a shelf of 30, sent at once: one stands.
    const send = () => request.post(`${API}/cycles/${a.id}/transfers`, { headers, data: { toCycleId: b.id, reason: 'race', lines: [{ productId: pad.id, qty: 20 }] } });
    const results = await Promise.all([send(), send(), send(), send(), send()]);
    const ok = results.filter((r) => r.ok());
    expect(ok, (await Promise.all(results.map((r) => r.text()))).join(' | ')).toHaveLength(1);
    for (const refused of results.filter((r) => !r.ok())) {
      expect((await refused.json()).error.code).toBe('TRANSFER_MORE_THAN_ON_SHELF');
    }
    const moved = (await ok[0].json()).data;

    const after = await preview(request, headers, a.id);
    expect(after.grossProfitEgp).toBe(before.grossProfitEgp);
    expect(Number(before.unsoldValueEgp) - Number(after.unsoldValueEgp)).toBe(2000);
    expect(moved.totalCostEgp).toBe('2000.00');
    expect((await fundB()) - fundBefore).toBe(2000);
    const ledger = async (cycleId: string) =>
      ((await (await request.get(`${API}/ledger?cycleId=${cycleId}&limit=200`, { headers })).json()).data as any[])
        .filter((r) => r.category === 'cycle_transfer')
        .map((r) => [r.direction, Number(r.amount), 'accountId' in r]);
    expect(await ledger(a.id)).toEqual([['INFLOW', 2000, false]]);
    expect(await ledger(b.id)).toEqual([['OUTFLOW', 2000, false]]);
    expect((await profitability(request, headers, a.id)).profit).toBe(1000);
  });

  test('TC-INV-52: the business’s cash in, cash out, cash on hand and net profit are the same before a move, after it, and after undoing it', async ({ request }) => {
    const { headers, mk, a, b, pad } = await leftoverWorld(request, 'Inv L5 Cash');
    const pick = (d: any) => [d.totalCashIn, d.totalCashOut, d.cashOnHand, d.netProfit, d.inventoryValue];
    const before = pick(await dashboard(request, headers));
    const t = await mk(`cycles/${a.id}/transfers`, { toCycleId: b.id, reason: 'cash', lines: [{ productId: pad.id, qty: 30 }] });
    expect(pick(await dashboard(request, headers))).toEqual(before);
    await mk(`stock-transfers/${t.id}/undo`, { reason: 'back' });
    expect(pick(await dashboard(request, headers))).toEqual(before);
  });

  test('TC-INV-53: after B sells moved units, preview, approve, the partners page and analytics agree — for A and for B', async ({ request }) => {
    const { headers, mk, a, b, pad, customer } = await leftoverWorld(request, 'Inv L5 Agree', { bFunding: 3000 });
    await mk(`cycles/${a.id}/transfers`, { toCycleId: b.id, reason: 'agree', lines: [{ productId: pad.id, qty: 30 }] });
    const order = await mk('sales/orders', {
      customerId: customer.id, channel: 'B2B', currency: 'EGP',
      items: [{ productId: pad.id, quantity: 5, unitPrice: 300, discount: 0 }],
    });
    await mk(`sales/orders/${order.id}/confirm`, { version: order.version });

    const participation: any[] = (await (await request.get(`${API}/users/participation`, { headers })).json()).data;
    for (const [cycle, profit] of [[a, 1000], [b, 1000]] as const) {
      const pr = await preview(request, headers, cycle.id);
      expect(pr.grossProfitEgp, cycle.code).toBe(`${profit}.00`); // B: 5 × (300 − 100)
      expect((await profitability(request, headers, cycle.id)).profit, cycle.code).toBe(profit);
      const accrued = participation
        .flatMap((u) => u.cycles.filter((c: any) => c.id === cycle.id))
        .reduce((s: number, c: any) => s + c.accruedProfitEgp, 0);
      expect(accrued, cycle.code).toBe(profit);
    }
    // B's units still on the shelf are its own unsold stock, at A's cost.
    expect((await preview(request, headers, b.id)).unsoldValueEgp).toBe('2500.00');

    // Approve A: the same figures are settled, and it has nothing to write off.
    const draft = await mk(`settlements/calculate/${a.id}`, {});
    const approved = (await (await request.post(`${API}/settlements/${draft.id}/approve`, { headers, data: {} })).json()).data;
    expect(Number(approved.grossProfitEgp)).toBe(1000);
    expect(Number(approved.unitsRemaining)).toBe(0);
  });
});

test.describe('A manual ledger entry can’t lie (L6, §9)', () => {
  const dashboard = async (request: APIRequestContext, headers: any) =>
    (await (await request.get(`${API}/analytics/dashboard`, { headers })).json()).data;
  const preview = async (request: APIRequestContext, headers: any, id: string) =>
    (await (await request.get(`${API}/settlements/preview/${id}`, { headers })).json()).data;
  const profitability = async (request: APIRequestContext, headers: any, id: string) =>
    ((await (await request.get(`${API}/analytics/cycle-profitability`, { headers })).json()).data as any[]).find((c) => c.cycleId === id);
  const post = (request: APIRequestContext, headers: any, data: any) =>
    request.post(`${API}/ledger`, { headers, data });
  const refusal = async (res: any) => ({ status: res.status(), code: (await res.json()).error?.code });
  /** Rows carrying this note — none may exist after a refusal. */
  const rowsNoted = async (request: APIRequestContext, headers: any, note: string) =>
    ((await (await request.get(`${API}/ledger?limit=200`, { headers })).json()).data as any[]).filter((r) => r.reason === note);
  const rent = (over: any = {}) => ({ kind: 'EXPENSE', category: 'rent', amount: 300, currency: 'EGP', occurredOn: dayFromNow(-1), ...over });

  test('TC-INV-54: no category a flow writes can be typed by hand, as an expense or as income, in either direction', async ({ request }) => {
    const { headers } = await apiCtx(request);
    const note = `inv54 ${Date.now()}`;
    const system = ['purchase', 'shipping', 'settlement', 'contribution', 'lender_financing', 'lender_repayment', 'supplier_refund', 'loss_refund', 'revenue', 'refund', 'Rent', 'misc'];
    for (const category of system) {
      for (const [kind, direction] of [['EXPENSE', 'OUTFLOW'], ['OTHER_INCOME', 'INFLOW']]) {
        const r = await refusal(await post(request, headers, { kind, direction, category, amount: 100, currency: 'EGP', note }));
        expect(r, `${category} as ${kind}`).toEqual({ status: 400, code: 'LEDGER_CATEGORY_NOT_MANUAL' });
      }
    }
    expect((await refusal(await post(request, headers, rent({ category: 'cycle_transfer', note })))).code).toBe('LEDGER_CATEGORY_RESERVED');
    // The old body shape: a free type, a direction, no kind.
    const old = await post(request, headers, { type: 'PURCHASE_COST', category: 'purchase', direction: 'INFLOW', amount: 100, currency: 'EGP' });
    expect(old.status()).toBe(400);
    expect(await rowsNoted(request, headers, note)).toHaveLength(0);
  });

  test('TC-INV-55: too little, backwards, the wrong way round, a lie about where it came from, a cycle that is not there or is shut — each refused, nothing written', async ({ request }) => {
    const { headers, mk } = await apiCtx(request);
    const note = `inv55 ${Date.now()}`;
    const shut = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'EGP' });
    await mk(`cycles/${shut.id}/transition`, { status: 'CANCELLED' });
    const cases: [string, any, number, string][] = [
      ['zero', rent({ amount: 0 }), 400, 'LEDGER_AMOUNT_NOT_POSITIVE'],
      ['negative', rent({ amount: -300 }), 400, 'LEDGER_AMOUNT_NOT_POSITIVE'],
      ['tomorrow', rent({ occurredOn: dayFromNow(1) }), 400, 'DATE_IN_FUTURE'],
      ['not a day', rent({ occurredOn: '2026-02-30' }), 400, 'BAD_DATE'],
      ['expense as money in', rent({ direction: 'INFLOW' }), 400, 'LEDGER_DIRECTION_MISMATCH'],
      ['income as money out', { ...rent(), kind: 'OTHER_INCOME', category: 'interest', direction: 'OUTFLOW' }, 400, 'LEDGER_DIRECTION_MISMATCH'],
      ['interest as an expense', rent({ category: 'interest' }), 400, 'LEDGER_CATEGORY_WRONG_KIND'],
      ['a system type', rent({ type: 'SETTLEMENT_PAYOUT' }), 400, 'LEDGER_TYPE_NOT_MANUAL'],
      ['dollars with no rate', rent({ currency: 'USD' }), 400, 'LEDGER_RATE_NOT_POSITIVE'],
      ['pounds at 2', rent({ fxRateToEgp: 2 }), 400, 'LEDGER_EGP_RATE'],
      ['posing as a flow', rent({ relatedType: 'SALE_RETURN', relatedId: shut.id }), 400, 'VALIDATION_FAILED'],
      ['extra freight, no cycle', rent({ category: 'extra_freight' }), 400, 'LEDGER_CYCLE_REQUIRED'],
      ['a cycle id that is no cycle', rent({ cycleId: '00000000-0000-4000-8000-000000000999' }), 404, 'NOT_FOUND'],
      ['a cycle code for an id', rent({ cycleId: shut.code }), 404, 'NOT_FOUND'],
      ['a cancelled cycle', rent({ cycleId: shut.id }), 400, 'LEDGER_CYCLE_NOT_OPEN'],
    ];
    for (const [what, body, status, code] of cases) {
      expect(await refusal(await post(request, headers, { ...body, note })), what).toEqual({ status, code });
    }
    expect(await rowsNoted(request, headers, note)).toHaveLength(0);
  });

  test('TC-INV-56: only a core partner writes an entry — the office, an investor and a shop are refused with a code; the partner is not', async ({ request }) => {
    const { headers } = await apiCtx(request);
    const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const email = `inv56-office-${stamp}@motoparts.com`;
    const made = await request.post(`${API}/auth/register`, { headers, data: { email, password: PASSWORD, displayName: `Office ${stamp}`, role: 'ADMIN_SUPPORT' } });
    expect(made.ok(), await made.text()).toBeTruthy();
    const office = { Authorization: `Bearer ${(await (await request.post(`${API}/auth/login`, { data: { email, password: PASSWORD } })).json()).data.accessToken}` };
    const note = `inv56 ${stamp}`;
    for (const caller of [{ who: 'ADMIN_SUPPORT', headers: office, code: 'ROLE_NOT_ALLOWED' }, ...(await refusedCallers(request, 'inv56'))]) {
      const r = await refusal(await post(request, caller.headers, rent({ note })));
      expect(r, caller.who).toEqual({ status: 403, code: caller.code });
    }
    expect(await rowsNoted(request, headers, note)).toHaveLength(0);
    // The office still reads the ledger.
    expect((await request.get(`${API}/ledger?limit=1`, { headers: office })).ok()).toBeTruthy();
    const ok = await post(request, headers, rent({ note }));
    expect(ok.status(), await ok.text()).toBe(201);
    const row = (await ok.json()).data;
    expect(row).toMatchObject({ type: 'EXPENSE', category: 'rent', direction: 'OUTFLOW', currency: 'EGP' });
    expect(Number(row.amount)).toBe(300);
    expect(row.occurredOn.slice(0, 10)).toBe(dayFromNow(-1));
  });

  test('TC-INV-57: an expense and other income charged to a cycle move its settlement and its page by the same amount, and the dashboard by the same; undone, they all come back', async ({ request }) => {
    const { headers, a } = await leftoverWorld(request, 'Inv L6 Cycle');
    // 10 sold at 200 that cost 100: 1,000 profit before anything is charged.
    expect((await preview(request, headers, a.id)).grossProfitEgp).toBe('1000.00');
    expect((await profitability(request, headers, a.id)).profit).toBe(1000);
    const before = await dashboard(request, headers);

    const ok = async (body: any) => {
      const res = await post(request, headers, body);
      expect(res.status(), await res.text()).toBe(201);
      return (await res.json()).data;
    };
    const rentRow = await ok(rent({ cycleId: a.id }));
    await ok(rent({ category: 'extra_freight', amount: 200, cycleId: a.id }));
    await ok({ kind: 'OTHER_INCOME', category: 'interest', amount: 50, currency: 'EGP', cycleId: a.id });
    // In dollars: 10 at 50 is 500 pounds, and pounds are what is counted.
    const usd = await ok(rent({ category: 'bank_fees', amount: 10, currency: 'USD', fxRateToEgp: 50, cycleId: a.id }));
    expect(Number(usd.amount)).toBe(500);
    expect(usd.originalCurrency).toBe('USD');

    // 1,000 − 300 − 200 − 500 + 50 = 50, on both.
    expect((await preview(request, headers, a.id)).grossProfitEgp).toBe('50.00');
    const page = await profitability(request, headers, a.id);
    expect(page).toMatchObject({ profit: 50, expensesEgp: 1000, otherIncomeEgp: 50 });
    const after = await dashboard(request, headers);
    expect(Math.round((after.totalExpenses - before.totalExpenses) * 100) / 100).toBe(1000);
    expect(Math.round((after.totalOtherIncomeEgp - before.totalOtherIncomeEgp) * 100) / 100).toBe(50);
    expect(Math.round((after.netProfit - before.netProfit) * 100) / 100).toBe(-950);
    expect(after.totalRevenue).toBe(before.totalRevenue);

    // The second time: undo the rent. It stops counting everywhere.
    const rev = await request.post(`${API}/ledger/${rentRow.id}/reverse`, { headers, data: { reason: 'entered twice' } });
    expect(rev.ok(), await rev.text()).toBeTruthy();
    expect((await preview(request, headers, a.id)).grossProfitEgp).toBe('350.00');
    expect((await profitability(request, headers, a.id)).profit).toBe(350);
    const undone = await dashboard(request, headers);
    expect(Math.round((undone.totalExpenses - before.totalExpenses) * 100) / 100).toBe(700);
    expect(Math.round((undone.netProfit - before.netProfit) * 100) / 100).toBe(-650);
    // And it cannot be undone twice.
    const again = await request.post(`${API}/ledger/${rentRow.id}/reverse`, { headers, data: { reason: 'again' } });
    expect((await refusal(again)).code).toBe('ENTRY_ALREADY_REVERSED');
  });

  test('TC-INV-58: a sale returned for cash comes off Revenue once and is not an expense', async ({ request }) => {
    const { headers, mk, customer } = await leftoverWorld(request, 'Inv L6 Return');
    const orders: any[] = (await (await request.get(`${API}/sales/orders?customerId=${customer.id}&limit=10`, { headers })).json()).data;
    const order = orders[0];
    await mk('payments', { customerId: customer.id, amount: 2000, currency: 'EGP', orderId: order.id });
    const item = (await (await request.get(`${API}/sales/orders/${order.id}`, { headers })).json()).data.items[0];
    const before = await dashboard(request, headers);
    // Two of the ten come back for cash: 400 of revenue, 200 of cost back on the shelf.
    await mk('returns', { saleOrderId: order.id, reason: 'two came back', refundMethod: 'CASH', items: [{ saleItemId: item.id, qty: 2 }] });
    const after = await dashboard(request, headers);
    const d = (k: string) => Math.round((after[k] - before[k]) * 100) / 100;
    expect(d('totalRevenue')).toBe(-400);
    expect(d('totalCogs')).toBe(-200);
    expect(d('totalExpenses')).toBe(0);
    expect(d('netProfit')).toBe(-200);
  });
});

// ─── L8: goods leave in parts (owner, 2026-10-12) ───────────────────────
// Every rule the departures agreed gets a test here (CLAUDE.md §1): what can
// leave, when it can, what can come after it, and that every unit is still
// in exactly one place.

test.describe('Goods that leave in parts', () => {
  const ago = (n: number) => dayFromNow(-n);

  /** A China cycle, 40 ordered 60 days ago, both legs recorded, nothing departed. */
  async function china(request: APIRequestContext) {
    const { headers, mk } = await apiCtx(request);
    const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const product = await mk('products', { name: `InvL8 ${stamp} Part`, minStock: 0 });
    const supplier = await mk('suppliers', { name: `InvL8 ${stamp} Sup`, country: 'CN' });
    const cycle = await mk('cycles', { originType: 'CHINA', currency: 'EGP' });
    await mk(`cycles/${cycle.id}/purchases`, {
      supplierId: supplier.id, currency: 'EGP', fxRateToEgp: 1, orderedOn: ago(60),
      items: [{ productId: product.id, orderedQty: 40, unitPrice: 100 }],
    });
    const legs = [
      await mk(`cycles/${cycle.id}/shipping-legs`, { sequence: 1, origin: 'Guangzhou, CN', destination: 'Dubai, UAE', costBasis: 'FLAT', amount: 400, currency: 'EGP', fxRateToEgp: 1 }),
      await mk(`cycles/${cycle.id}/shipping-legs`, { sequence: 2, origin: 'Dubai, UAE', destination: 'Cairo, Egypt', costBasis: 'FLAT', amount: 0, currency: 'EGP', fxRateToEgp: 1 }),
    ];
    const full = await (await request.get(`${API}/cycles/${cycle.id}`, { headers })).json();
    const item = (full.data ?? full).purchaseOrders[0].items[0];
    const call = async (path: string, data: unknown) => {
      const res = await request.post(`${API}/${path}`, { headers, data });
      const body = await res.json().catch(() => ({}));
      return { status: res.status(), code: body?.error?.code, body };
    };
    const lines = (qty: number) => [{ purchaseOrderItemId: item.id, qty }];
    const depart = (legIdx: number, day: string, qty?: number) =>
      call(`shipping/legs/${legs[legIdx].id}/departures`, { departedOn: day, ...(qty === undefined ? {} : { lines: lines(qty) }) });
    const deliver = (legIdx: number, day: string, qty: number) =>
      call(`shipping/legs/${legs[legIdx].id}/deliveries`, { arrivedOn: day, lines: lines(qty) });
    const lose = (legIdx: number, qty: number) => call(`shipping/legs/${legs[legIdx].id}/losses`, { lines: lines(qty) });
    const shipment = async () => {
      const r = await (await request.get(`${API}/cycles/${cycle.id}/shipment`, { headers })).json();
      return r.data ?? r;
    };
    return { headers, mk, cycle, legs, item, depart, deliver, lose, shipment };
  }

  test('TC-INV-L8-01: a leg never sends on more than entered it — on leg 1 more than was ordered, on leg 2 more than leg 1 delivered', async ({ request }) => {
    const w = await china(request);
    expect((await w.depart(0, ago(30), 41)).code).toBe('DEPARTURE_EXCEEDS_WAITING');
    expect((await w.depart(0, ago(30), 40)).status).toBeLessThan(300);
    expect((await w.depart(0, ago(29), 1)).code).toBe('DEPARTURE_EXCEEDS_WAITING');
    await w.deliver(0, ago(20), 25);
    expect((await w.depart(1, ago(18), 26)).code).toBe('DEPARTURE_EXCEEDS_WAITING');
    expect((await w.depart(1, ago(18), 25)).status).toBeLessThan(300);
    const s = await w.shipment();
    for (const leg of s.legs) {
      for (const l of leg.lines) expect(l.departed, `leg ${leg.sequence}`).toBeLessThanOrEqual(l.entered);
    }
  });

  test('TC-INV-L8-02: only what left arrives or is lost — delivered plus lost never exceeds what left', async ({ request }) => {
    const w = await china(request);
    expect((await w.deliver(0, ago(20), 1)).code).toBe('LEG_NOT_DEPARTED');
    expect((await w.lose(0, 1)).code).toBe('LOSS_EXCEEDS_IN_TRANSIT');
    await w.depart(0, ago(30), 10);
    expect((await w.deliver(0, ago(20), 11)).code).toBe('DELIVERY_EXCEEDS_IN_TRANSIT');
    await w.deliver(0, ago(20), 7);
    expect((await w.lose(0, 4)).code).toBe('LOSS_EXCEEDS_IN_TRANSIT');
    await w.lose(0, 3);
    const leg1 = (await w.shipment()).legs[0].lines[0];
    expect(leg1.delivered + leg1.lost).toBeLessThanOrEqual(leg1.departed);
    expect(leg1.atOrigin).toBe(30);
  });

  test('TC-INV-L8-03: nothing leaves before it could be there — before the order, or before leg 1 brought it to Dubai — nor arrives before it left', async ({ request }) => {
    const w = await china(request);
    expect((await w.depart(0, ago(61), 5)).code).toBe('DEPARTURE_BEFORE_ORDER');
    await w.depart(0, ago(40), 10);
    await w.depart(0, ago(20), 30);
    // On day 30-ago only the first 10 had left.
    expect((await w.deliver(0, ago(30), 11)).code).toBe('DELIVERY_BEFORE_GOODS_LEFT');
    await w.deliver(0, ago(30), 10);
    expect((await w.depart(1, ago(31), 1)).code).toBe('DEPARTURE_BEFORE_ARRIVAL');
    expect((await w.depart(1, ago(30), 10)).status).toBeLessThan(300);
  });

  test('TC-INV-L8-04: nothing departs, and nothing is undone, on a cycle that is cancelled', async ({ request }) => {
    const w = await china(request);
    await w.mk(`cycles/${w.cycle.id}/transition`, { status: 'CANCELLED' });
    expect((await w.depart(0, ago(10), 1)).code).toBe('CYCLE_CLOSED');
    expect((await w.shipment()).legs.flatMap((l: any) => l.departures)).toEqual([]);
  });

  test('TC-INV-L8-05: whatever happened in whatever order, every unit is in exactly one place and the places add up to what was ordered', async ({ request }) => {
    const w = await china(request);
    await w.depart(0, ago(40), 25);
    await w.deliver(0, ago(30), 20);
    await w.lose(0, 2);
    await w.depart(0, ago(29), 10);
    await w.depart(1, ago(25), 12);
    await w.deliver(1, ago(10), 9);
    await w.lose(1, 1);
    const s = await w.shipment();
    const t = s.totals;
    expect(t.atOrigin + t.onTheWay + t.waiting + t.received + t.lost).toBe(t.ordered);
    expect(t.ordered).toBe(40);
    // Per leg: entered = waiting at origin + on the way + delivered + lost (the last leg's
    // delivered is waiting or received), never a unit short or spare.
    for (const leg of s.legs) {
      const l = leg.lines[0];
      expect(l.atOrigin + l.onTheWay + l.delivered + l.lost, `leg ${leg.sequence}`).toBe(l.entered);
    }
  });
});

// ─── L7: running costs come out of the core partners' payouts (owner, 2026-10-11) ─
// Every rule the owner agreed gets its guard here (CLAUDE.md §1). Running
// costs are the whole business's, so each test reads what is already waiting
// and asserts on what its own payout changes.

test.describe('Running costs come out of the core partners’ payouts (L7, §8)', () => {
  const dashboard = async (request: APIRequestContext, headers: any) =>
    (await (await request.get(`${API}/analytics/dashboard`, { headers })).json()).data;
  const pay = async (request: APIRequestContext, headers: any, id: string) => {
    const res = await request.post(`${API}/settlements/${id}/pay`, { headers, data: {} });
    expect(res.ok(), await res.text()).toBeTruthy();
  };
  const reverse = async (request: APIRequestContext, headers: any, id: string) => {
    const res = await request.post(`${API}/settlements/${id}/reverse`, { headers, data: { reason: 'paid the wrong figures' } });
    expect(res.ok(), await res.text()).toBeTruthy();
  };
  const line = (s: any, userId: string) =>
    s.breakdown.participants.find((p: any) => s.lines.find((l: any) => l.participantId === p.participantId)?.participant?.partnerUserId === userId);

  test('TC-INV-59: a cost is charged once in total — each partner his own share, the next payout takes nothing more of it, and taken + waiting is always what was spent', async ({ request }) => {
    const { headers } = await apiCtx(request);
    const user = await usersByEmail(request, headers);
    const a = user('partner.a@motoparts.com');
    const b = user('partner.b@motoparts.com');
    await recordCost(request, headers, { amount: 3000, note: `inv59 ${Date.now()}` });
    const before = await runningCosts(request, headers);
    const owedA = waitingFor(before, a.id);
    expect(owedA, 'A owes something').toBeGreaterThan(0);

    // A and B fund it heavily, so both payouts cover all they owe.
    const first = await soldOutCycle(request, 'Inv L7 First', [[a.id, 'CORE_PARTNER', 60000], [b.id, 'CORE_PARTNER', 40000]]);
    const id1 = await approved(first.mk, first.cycle.id);
    await pay(request, headers, id1);
    const after = await runningCosts(request, headers);
    expect(waitingFor(after, a.id)).toBe(0);
    expect(waitingFor(after, b.id)).toBe(0);
    expect(cents(Number(after.chargedEgp) + Number(after.waitingEgp))).toBe(cents(after.spentEgp));
    const s1 = await settlement(request, headers, id1);
    expect(cents(line(s1, a.id).runningCostsEgp)).toBe(-cents(owedA));

    // The second payout to A, from another cycle: nothing left of his to take.
    const second = await soldOutCycle(request, 'Inv L7 Second', [[a.id, 'CORE_PARTNER', 10000]]);
    const id2 = await approved(second.mk, second.cycle.id);
    await pay(request, headers, id2);
    const s2 = await settlement(request, headers, id2);
    expect(line(s2, a.id).runningCostsStatus).toBe('none');
    expect(cents((await runningCosts(request, headers)).chargedEgp)).toBe(cents(after.chargedEgp));
  });

  test('TC-INV-60: reversing the settlement puts its running costs back to waiting, and its ledger rows net to nothing', async ({ request }) => {
    const { headers } = await apiCtx(request);
    const user = await usersByEmail(request, headers);
    const a = user('partner.a@motoparts.com');
    await recordCost(request, headers, { amount: 900, category: 'utilities' });
    const before = await runningCosts(request, headers);
    const w = await soldOutCycle(request, 'Inv L7 Reverse', [[a.id, 'CORE_PARTNER', 50000]]);
    const id = await approved(w.mk, w.cycle.id);
    const cash0 = (await dashboard(request, headers)).cashOnHand;
    await pay(request, headers, id);
    expect(waitingFor(await runningCosts(request, headers), a.id)).toBe(0);
    await reverse(request, headers, id);
    const back = await runningCosts(request, headers);
    expect(cents(waitingFor(back, a.id))).toBe(cents(waitingFor(before, a.id)));
    expect(cents(back.chargedEgp)).toBe(cents(before.chargedEgp));
    expect(cents((await dashboard(request, headers)).cashOnHand)).toBe(cents(cash0));
    const rows = await settlementRows(request, headers, id);
    const net = rows.filter((r) => r.category === 'running_cost_share').reduce((s, r) => s + (r.direction === 'INFLOW' ? 1 : -1) * Number(r.amount), 0);
    expect(rows.some((r) => r.category === 'running_cost_share')).toBe(true);
    expect(cents(net)).toBe(0);
  });

  test('TC-INV-61: a temporary investor is never charged, however big his payout; a partner’s cash out is his payout less his share', async ({ request }) => {
    const { headers } = await apiCtx(request);
    const user = await usersByEmail(request, headers);
    const a = user('partner.a@motoparts.com');
    const investor = user('investor@motoparts.com');
    await recordCost(request, headers, { amount: 1200, category: 'salaries' });
    const owedA = waitingFor(await runningCosts(request, headers), a.id);
    const w = await soldOutCycle(request, 'Inv L7 Investor', [[a.id, 'CORE_PARTNER', 20000], [investor.id, 'TEMP_INVESTOR', 80000, 10]]);
    const id = await approved(w.mk, w.cycle.id);
    const cash0 = (await dashboard(request, headers)).cashOnHand;
    await pay(request, headers, id);
    const s = await settlement(request, headers, id);
    const inv = s.breakdown.participants.find((p: any) => p.type === 'TEMP_INVESTOR');
    expect(inv.runningCostsStatus).toBe('none');
    expect(inv.runningCostsEgp).toBe('0.00');
    // 2,000 profit, 80% his: 1,600, less a 10% fee of 160 → 1,440 + 80,000.
    expect(inv.paidEgp).toBe('81440.00');
    const pa = line(s, a.id);
    // 20,000 + 400 + the 160 fee, less his share of what was waiting.
    expect(cents(pa.paidEgp)).toBe(cents(20560 - owedA));
    const payouts = (await settlementRows(request, headers, id)).filter((r) => r.type === 'SETTLEMENT_PAYOUT');
    expect(payouts.map((r) => cents(r.amount)).sort((x, y) => x - y)).toEqual([cents(pa.paidEgp), cents(inv.paidEgp)].sort((x, y) => x - y));
    // Cash leaves for exactly what was handed over.
    const cash1 = (await dashboard(request, headers)).cashOnHand;
    expect(cents(cash0) - cents(cash1)).toBe(cents(pa.paidEgp) + cents(inv.paidEgp));
  });

  test('TC-INV-62: a cost charged to a cycle is that cycle’s, never a running cost; rent never touches a cycle’s profit', async ({ request }) => {
    const { headers } = await apiCtx(request);
    const user = await usersByEmail(request, headers);
    const a = user('partner.a@motoparts.com');
    const w = await soldOutCycle(request, 'Inv L7 Profit', [[a.id, 'CORE_PARTNER', 5000]]);
    const preview = async () => (await (await request.get(`${API}/settlements/preview/${w.cycle.id}`, { headers })).json()).data.grossProfitEgp;
    expect(await preview()).toBe('2000.00');
    const spent0 = (await runningCosts(request, headers)).spentEgp;
    await recordCost(request, headers, { amount: 500, category: 'extra_freight', cycleId: w.cycle.id });
    expect((await runningCosts(request, headers)).spentEgp, 'a cycle cost is not spent as running costs').toBe(spent0);
    expect(await preview()).toBe('1500.00');
    await recordCost(request, headers, { amount: 7000 });
    expect(await preview(), 'rent never moves a cycle’s profit').toBe('1500.00');
    const id = await approved(w.mk, w.cycle.id);
    await pay(request, headers, id);
    const s = await settlement(request, headers, id);
    expect(Number(s.grossProfitEgp)).toBe(1500);
    expect(s.breakdown.costs).toEqual([{ kind: 'charge', category: 'extra_freight', amountEgp: '500.00' }]);
  });

  test('TC-INV-63: a running cost already taken from a payout cannot be reversed until that settlement is; a period that ends before it starts is refused; an investor cannot read them', async ({ request }) => {
    const { headers } = await apiCtx(request);
    const user = await usersByEmail(request, headers);
    const a = user('partner.a@motoparts.com');
    const rent = await recordCost(request, headers, { amount: 600 });
    const w = await soldOutCycle(request, 'Inv L7 Undo', [[a.id, 'CORE_PARTNER', 50000]]);
    const id = await approved(w.mk, w.cycle.id);
    await pay(request, headers, id);
    const refused = await request.post(`${API}/ledger/${rent.id}/reverse`, { headers, data: { reason: 'wrong month' } });
    expect(refused.status()).toBe(400);
    expect((await refused.json()).error.code).toBe('RUNNING_COST_CHARGED');
    await reverse(request, headers, id);
    const allowed = await request.post(`${API}/ledger/${rent.id}/reverse`, { headers, data: { reason: 'wrong month' } });
    expect(allowed.ok(), await allowed.text()).toBeTruthy();

    const backwards = await request.get(`${API}/settlements/running-costs?from=2026-09-30&to=2026-07-01`, { headers });
    expect(backwards.status()).toBe(400);
    expect((await backwards.json()).error.code).toBe('DATE_RANGE_REVERSED');
    for (const caller of await refusedCallers(request, 'inv63')) {
      const r = await request.get(`${API}/settlements/running-costs`, { headers: caller.headers });
      expect(r.status(), caller.who).toBe(403);
      expect((await r.json()).error.code, caller.who).toBe(caller.code);
    }
  });

  test('TC-INV-64: cash on hand counts only cash handed back — a 300 cash refund is 300, a credit-note return is nothing', async ({ request }) => {
    const { headers, mk, customer } = await leftoverWorld(request, 'Inv L7 Cash');
    const order = ((await (await request.get(`${API}/sales/orders?customerId=${customer.id}&limit=10`, { headers })).json()).data as any[])[0];
    await mk('payments', { customerId: customer.id, amount: 2000, currency: 'EGP', orderId: order.id });
    const item = (await (await request.get(`${API}/sales/orders/${order.id}`, { headers })).json()).data.items[0];
    const cash = async () => cents((await dashboard(request, headers)).cashOnHand);
    const c0 = await cash();
    // One pad back for cash: 200 handed over.
    await mk('returns', { saleOrderId: order.id, reason: 'one came back for cash', refundMethod: 'CASH', items: [{ saleItemId: item.id, qty: 1 }] });
    const c1 = await cash();
    expect(c0 - c1).toBe(cents(200));
    await mk('returns', { saleOrderId: order.id, reason: 'one more, on credit', refundMethod: 'CREDIT_NOTE', items: [{ saleItemId: item.id, qty: 1 }] });
    expect(await cash()).toBe(c1);
  });
});

// ─── L7 alignment review (2026-10-12): a cost's shares are fixed on its own day,
// and the guards the review asked to see named.

test.describe('A running cost’s shares are fixed on its own day (L7 review, §8)', () => {
  const pay = async (request: APIRequestContext, headers: any, id: string) => {
    const res = await request.post(`${API}/settlements/${id}/pay`, { headers, data: {} });
    expect(res.ok(), await res.text()).toBeTruthy();
  };
  const setStatus = async (request: APIRequestContext, headers: any, id: string, status: string) => {
    const res = await request.put(`${API}/users/${id}`, { headers, data: { status } });
    expect(res.ok(), await res.text()).toBeTruthy();
  };
  const shareOf = (rc: any, userId: string) => Number(rc.partners.find((p: any) => p.userId === userId)?.shareEgp ?? 0);
  /** The seeded partners have been partners since January, as the real three have. */
  const partnersSinceJanuary = () =>
    psqlStdin(`UPDATE partners SET created_at = '2026-01-01T08:00:00Z' WHERE user_id IN (SELECT id FROM users WHERE email IN ('partner.a@motoparts.com','partner.b@motoparts.com','partner.c@motoparts.com'));`);

  test('TC-INV-65: C leaves with his share unpaid — A and B are never charged more than their own share, and C’s stays waiting, shown as his', async ({ request }) => {
    const { headers } = await apiCtx(request);
    const user = await usersByEmail(request, headers);
    const [a, b, c] = ['a', 'b', 'c'].map((x) => user(`partner.${x}@motoparts.com`));
    const before = await runningCosts(request, headers);
    await recordCost(request, headers, { amount: 900 });
    const after = await runningCosts(request, headers);
    const owed = (u: any) => shareOf(after, u.id) - shareOf(before, u.id);
    expect(cents(owed(c)), 'C owes a share of it').toBeGreaterThan(0);

    // The three funded a cycle together; C leaves before it is paid out.
    const w = await soldOutCycle(request, 'Inv L7 Leaves', [[a.id, 'CORE_PARTNER', 50000], [b.id, 'CORE_PARTNER', 50000], [c.id, 'CORE_PARTNER', 50000]]);
    const id = await approved(w.mk, w.cycle.id);
    await setStatus(request, headers, c.id, 'SUSPENDED');
    try {
      const waitingA = waitingFor(after, a.id);
      const waitingB = waitingFor(after, b.id);
      await pay(request, headers, id);
      const s = await settlement(request, headers, id);
      const lineOf = (uid: string) => s.breakdown.participants.find((p: any) => s.lines.find((l: any) => l.participantId === p.participantId)?.participant?.partnerUserId === uid);
      // Each takes exactly what he himself owed — not a penny of C's.
      expect(cents(lineOf(a.id).runningCostsEgp)).toBe(-cents(waitingA));
      expect(cents(lineOf(b.id).runningCostsEgp)).toBe(-cents(waitingB));
      expect(lineOf(c.id).runningCostsStatus, 'C, no longer a partner, is not charged').toBe('none');
      const now = await runningCosts(request, headers);
      const cRow = now.partners.find((p) => p.userId === c.id) as any;
      expect(cRow, 'C still listed while he owes').toBeTruthy();
      expect(cRow.active).toBe(false);
      expect(cents(cRow.waitingEgp)).toBeGreaterThanOrEqual(cents(owed(c)));
      expect(cents(shareOf(now, a.id))).toBe(cents(shareOf(after, a.id)));
    } finally {
      await setStatus(request, headers, c.id, 'ACTIVE');
    }
  });

  test('TC-INV-66: D joins after the cost’s day — he is never charged for it; a cost on his watch is his too', async ({ request }) => {
    const { headers } = await apiCtx(request);
    partnersSinceJanuary();
    const stamp = `${Date.now()}`;
    const email = `inv66-partner-${stamp}@motoparts.com`;
    const made = await request.post(`${API}/auth/register`, { headers, data: { email, password: PASSWORD, displayName: `Partner D ${stamp}`, role: 'CORE_PARTNER' } });
    expect(made.ok(), await made.text()).toBeTruthy();
    const user = await usersByEmail(request, headers);
    const d = user(email);
    await recordCost(request, headers, { amount: 1200, occurredOn: dayFromNow(-2) });
    expect(shareOf(await runningCosts(request, headers, { from: dayFromNow(-2), to: dayFromNow(-2) }), d.id)).toBe(0);
    const w = await soldOutCycle(request, 'Inv L7 Joins', [[d.id, 'CORE_PARTNER', 50000]]);
    const id = await approved(w.mk, w.cycle.id);
    await pay(request, headers, id);
    const s = await settlement(request, headers, id);
    expect(s.breakdown.participants[0].runningCostsStatus, 'D is charged nothing of a cost before his day').toBe('none');
    // A cost on his watch is his too.
    await recordCost(request, headers, { amount: 400, category: 'utilities' });
    expect(shareOf(await runningCosts(request, headers, { from: dayFromNow(0), to: dayFromNow(0) }), d.id)).toBeGreaterThan(0);
    // He leaves again, so later tests share among the seeded three.
    await setStatus(request, headers, d.id, 'INACTIVE');
  });

  test('TC-INV-67: a core partner who is also an investor on the cycle — only his core-partner line is charged', async ({ request }) => {
    const { headers } = await apiCtx(request);
    const user = await usersByEmail(request, headers);
    const a = user('partner.a@motoparts.com');
    await recordCost(request, headers, { amount: 600 });
    const w = await soldOutCycle(request, 'Inv L7 Both', [[a.id, 'CORE_PARTNER', 20000], [a.id, 'TEMP_INVESTOR', 30000, 0]]);
    const id = await approved(w.mk, w.cycle.id);
    await pay(request, headers, id);
    const s = await settlement(request, headers, id);
    const byType = (t: string) => s.breakdown.participants.find((p: any) => p.type === t);
    expect(byType('CORE_PARTNER').runningCostsStatus).toBe('charged');
    expect(byType('TEMP_INVESTOR').runningCostsStatus).toBe('none');
    expect(s.lines.filter((l: any) => l.component === 'RUNNING_COSTS').map((l: any) => l.participant.participantType)).toEqual(['CORE_PARTNER']);
  });

  test('TC-INV-68: a running_cost_share is never typed by hand, and one cannot be reversed on its own', async ({ request }) => {
    const { headers } = await apiCtx(request);
    const user = await usersByEmail(request, headers);
    const a = user('partner.a@motoparts.com');
    for (const kind of ['EXPENSE', 'OTHER_INCOME']) {
      const r = await request.post(`${API}/ledger`, { headers, data: { kind, category: 'running_cost_share', amount: 100, currency: 'EGP' } });
      expect(r.status(), kind).toBe(400);
      expect((await r.json()).error.code, kind).toBe('LEDGER_CATEGORY_NOT_MANUAL');
    }
    await recordCost(request, headers, { amount: 300 });
    const w = await soldOutCycle(request, 'Inv L7 Memo', [[a.id, 'CORE_PARTNER', 20000]]);
    const id = await approved(w.mk, w.cycle.id);
    await pay(request, headers, id);
    const memo = (await settlementRows(request, headers, id)).find((r) => r.category === 'running_cost_share');
    expect(memo).toBeTruthy();
    const rev = await request.post(`${API}/ledger/${memo.id}/reverse`, { headers, data: { reason: 'undo it alone' } });
    expect(rev.status()).toBe(400);
    expect((await rev.json()).error.code).toBe('ENTRY_OWNED_ELSEWHERE');
  });

  test('TC-INV-69: Mark paid and reversal — refused to an investor and to the office with a code, done by a core partner', async ({ request }) => {
    const { headers } = await apiCtx(request);
    const user = await usersByEmail(request, headers);
    const a = user('partner.a@motoparts.com');
    const stamp = `${Date.now()}`;
    const email = `inv69-office-${stamp}@motoparts.com`;
    const made = await request.post(`${API}/auth/register`, { headers, data: { email, password: PASSWORD, displayName: `Office ${stamp}`, role: 'ADMIN_SUPPORT' } });
    expect(made.ok(), await made.text()).toBeTruthy();
    const office = { Authorization: `Bearer ${(await (await request.post(`${API}/auth/login`, { data: { email, password: PASSWORD } })).json()).data.accessToken}` };
    const callers = [{ who: 'ADMIN_SUPPORT', headers: office, code: 'ROLE_NOT_ALLOWED' }, ...(await refusedCallers(request, 'inv69'))];
    const w = await soldOutCycle(request, 'Inv L7 Who', [[a.id, 'CORE_PARTNER', 20000]]);
    const id = await approved(w.mk, w.cycle.id);
    for (const caller of callers) {
      const r = await request.post(`${API}/settlements/${id}/pay`, { headers: caller.headers, data: {} });
      expect(r.status(), `pay: ${caller.who}`).toBe(403);
      expect((await r.json()).error.code, `pay: ${caller.who}`).toBe(caller.code);
    }
    expect((await settlement(request, headers, id)).status).toBe('APPROVED');
    await pay(request, headers, id);
    for (const caller of callers) {
      const r = await request.post(`${API}/settlements/${id}/reverse`, { headers: caller.headers, data: { reason: 'not mine to undo' } });
      expect(r.status(), `reverse: ${caller.who}`).toBe(403);
      expect((await r.json()).error.code, `reverse: ${caller.who}`).toBe(caller.code);
    }
    expect((await settlement(request, headers, id)).status).toBe('PAID');
    const ok = await request.post(`${API}/settlements/${id}/reverse`, { headers, data: { reason: 'the partner undoes it' } });
    expect(ok.ok(), await ok.text()).toBeTruthy();
    expect((await settlement(request, headers, id)).status).toBe('REVERSED');
  });
});

test.describe('A corrected leg cost re-costs the cycle, and nothing disagrees afterwards (§2, 2026-10-17)', () => {
  /** A UAE-direct cycle: 10 ordered at 10, a leg at 0, everything received, 4 sold. */
  async function soldWithLegAtZero(request: APIRequestContext) {
    const { headers, mk, product, supplier, customer } = await ctx(request);
    const cycle = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'EGP' });
    await mk(`cycles/${cycle.id}/purchases`, {
      supplierId: supplier.id, currency: 'EGP', fxRateToEgp: 1, orderedOn: dayFromNow(-30),
      items: [{ productId: product.id, orderedQty: 10, unitPrice: 10 }],
    });
    const leg = await mk(`cycles/${cycle.id}/shipping-legs`, {
      sequence: 1, origin: 'Dubai, UAE', destination: 'Cairo, Egypt', provider: 'Inv Freight',
      costBasis: 'FLAT', amount: 0, currency: 'EGP', fxRateToEgp: 1,
      departedOn: dayFromNow(-20), arrivedOn: dayFromNow(-5),
    });
    for (const status of ['FUNDING', 'PURCHASING', 'ARRIVED_UAE', 'IN_TRANSIT_TO_EGYPT', 'ARRIVED_EGYPT', 'VERIFICATION']) {
      await mk(`cycles/${cycle.id}/transition`, { status });
    }
    const full = await (await request.get(`${API}/cycles/${cycle.id}`, { headers })).json();
    const poItem = (full.data ?? full).purchaseOrders[0].items[0];
    await mk('receipts/verify', { cycleId: cycle.id, items: [{ purchaseOrderItemId: poItem.id, productId: product.id, receivedQty: 10 }] });
    const order = await mk('sales/orders', {
      customerId: customer.id, channel: 'B2B', currency: 'EGP',
      items: [{ productId: product.id, quantity: 4, unitPrice: 50, discount: 0 }],
    });
    await mk(`sales/orders/${order.id}/confirm`, { version: order.version });
    return { headers, cycle, leg, poItem };
  }

  test('TC-INV-70: after a correction every sale of the cycle costs what its batch now costs, and the purchase rows re-sum to the landed cost', async ({ request }) => {
    const { headers, cycle, leg } = await soldWithLegAtZero(request);
    const res = await request.put(`${API}/shipping/legs/${leg.id}`, { headers, data: { costBasis: 'FLAT', amount: 50 } });
    expect(res.ok(), await res.text()).toBeTruthy();
    const disagreeing = psqlQuery(`
      SELECT count(*) FROM sale_item_allocations a JOIN inventory_batches b ON b.id = a.inventory_batch_id
       WHERE b.cycle_id = '${cycle.id}' AND (a.unit_cost_egp <> b.landed_unit_cost_egp OR a.cogs_egp <> round(a.qty * b.landed_unit_cost_egp, 2))`);
    expect(Number(disagreeing.trim())).toBe(0);
    const purchases = psqlQuery(`SELECT sum(amount) FROM financial_transactions WHERE cycle_id = '${cycle.id}' AND type = 'PURCHASE_COST'`);
    // 100 of goods and the 50 fee.
    expect(Number(purchases.trim())).toBe(150);
  });

  test('TC-INV-71: a correction once a settlement is drafted is refused by its code and moves nothing', async ({ request }) => {
    const { headers, cycle, leg } = await soldWithLegAtZero(request);
    psqlStdin(`INSERT INTO settlements (id, cycle_id, status, updated_at) VALUES (gen_random_uuid(), '${cycle.id}', 'DRAFT', now());`);
    const res = await request.put(`${API}/shipping/legs/${leg.id}`, { headers, data: { costBasis: 'FLAT', amount: 50 } });
    expect(res.status()).toBe(400);
    expect((await res.json()).error.code).toBe('LEG_COST_LOCKED_SETTLEMENT');
    const unit = psqlQuery(`SELECT landed_unit_cost_egp FROM inventory_batches WHERE cycle_id = '${cycle.id}'`);
    expect(Number(unit.trim())).toBe(10);
  });
});

test.describe('Samples left at a shop are not a sale (§4, samples at shops, 2026-10-18)', () => {
  /** Samples of `qty` units of a stocked product left at the context's shop. */
  async function samplesLeft(request: APIRequestContext, qty = 3) {
    const c = await ctx(request);
    await c.stockUp(10);
    const order = await c.mk('sales/orders', {
      samples: true, customerId: c.customer.id, channel: 'B2B', currency: 'EGP',
      items: [{ productId: c.product.id, quantity: qty }],
    });
    return { ...c, order };
  }
  const code = async (res: { json(): Promise<any> }) => (await res.json())?.error?.code;
  const dashboard = async (request: APIRequestContext, headers: any) => {
    const body = await (await request.get(`${API}/analytics/dashboard`, { headers })).json();
    return body.data ?? body;
  };

  test('TC-INV-72: samples owe nothing and add nothing to revenue or receivables; a payment against them is refused by its code', async ({ request }) => {
    const first = await ctx(request);
    const before = await dashboard(request, first.headers);
    const { headers, customer, order } = await samplesLeft(request);
    expect(order.status).toBe('SAMPLES');
    expect(Number(order.total)).toBe(0);
    const after = await dashboard(request, headers);
    expect(after.totalRevenue).toBe(before.totalRevenue);
    expect(after.receivables).toBe(before.receivables);
    const shop = await (await request.get(`${API}/customers/${customer.id}`, { headers })).json();
    expect(Number((shop.data ?? shop).outstandingBalance)).toBe(0);
    const res = await request.post(`${API}/payments`, {
      headers,
      data: { customerId: customer.id, amount: 10, currency: 'EGP', method: 'CASH', orderId: order.id },
    });
    expect(res.status()).toBe(400);
    expect(await code(res)).toBe('SAMPLES_NOT_PAYABLE');
  });

  test('TC-INV-73: completing a sale from samples with more than went out and the shelf holds, or with nothing on it, is refused by its code; completing twice is refused the second time', async ({ request }) => {
    // 10 received, 3 out as samples: 7 on the shelf, so at most 10 can be sold.
    const { headers, order, product } = await samplesLeft(request, 3);
    const convert = (items: unknown[]) =>
      request.post(`${API}/sales/orders/${order.id}/samples/convert`, { headers, data: { items } });
    const line = (quantity: number) => ({ productId: product.id, quantity, unitPrice: 50 });
    const tooMany = await convert([line(11)]);
    expect(tooMany.status()).toBe(400);
    expect(await code(tooMany)).toBe('SAMPLES_EXTRA_NOT_IN_STOCK');
    expect(await code(await convert([]))).toBe('SAMPLES_NOTHING_KEPT');
    const sold = await convert([line(4)]);
    expect(sold.ok()).toBeTruthy();
    expect(Number((await sold.json()).data.total)).toBe(200);
    expect(await code(await convert([line(4)]))).toBe('SAMPLES_ALREADY_DECIDED');
  });

  test('TC-INV-74: a cycle with units out as samples cannot be settled', async ({ request }) => {
    const { headers, order } = await samplesLeft(request, 2);
    const detail = await (await request.get(`${API}/sales/orders/${order.id}`, { headers })).json();
    const cycleId = (detail.data ?? detail).items[0].allocations[0].inventoryBatch.cycleId;
    const res = await request.post(`${API}/settlements/calculate/${cycleId}`, { headers });
    expect(res.status()).toBe(400);
    expect(await code(res)).toBe('CYCLE_HAS_SAMPLES_OUT');
  });
});

// ─── Rules agreed 2026-10-18, pinned 2026-10-19 ──────────────────────────

/**
 * A cycle of `qty` units landed at 10 each (EGP, a free leg), every unit
 * received, funded by partner A so it has a basis to settle on (rule 10).
 * Built the business's way (rule 4): order, leg, walk, check-in.
 */
async function shelfCycle(request: APIRequestContext, label: string, qty = 10) {
  const { headers, mk } = await apiCtx(request);
  const a = (await usersByEmail(request, headers))('partner.a@motoparts.com');
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const product = await mk('products', { name: `${label} ${stamp} Part`, minStock: 0 });
  const supplier = await mk('suppliers', { name: `${label} ${stamp} Supplier`, country: 'AE' });
  const customer = await mk('customers', { displayName: `${label} ${stamp} Shop`, type: 'B2B' });
  const cycle = await mk('cycles', {
    originType: 'UAE_DIRECT', currency: 'EGP',
    participants: [{ participantType: 'CORE_PARTNER', partnerUserId: a.id, contributionAmount: qty * 10 }],
  });
  const po = await mk(`cycles/${cycle.id}/purchases`, {
    supplierId: supplier.id, currency: 'EGP', fxRateToEgp: 1, orderedOn: dayFromNow(-30),
    items: [{ productId: product.id, orderedQty: qty, unitPrice: 10 }],
  });
  await mk(`cycles/${cycle.id}/shipping-legs`, {
    sequence: 1, origin: 'Dubai, UAE', destination: 'Cairo, Egypt', provider: `${label} Freight`,
    costBasis: 'FLAT', amount: 0, currency: 'EGP', fxRateToEgp: 1,
    departedOn: dayFromNow(-20), arrivedOn: dayFromNow(-5),
  });
  for (const status of ['FUNDING', 'PURCHASING', 'ARRIVED_UAE', 'IN_TRANSIT_TO_EGYPT', 'ARRIVED_EGYPT', 'VERIFICATION']) {
    await mk(`cycles/${cycle.id}/transition`, { status });
  }
  const full = await (await request.get(`${API}/cycles/${cycle.id}`, { headers })).json();
  const poItem = (full.data ?? full).purchaseOrders[0].items[0];
  await mk('receipts/verify', { cycleId: cycle.id, items: [{ purchaseOrderItemId: poItem.id, productId: product.id, receivedQty: qty }] });

  /** A confirmed sale of `quantity` at `unitPrice`. */
  const sell = async (quantity: number, unitPrice = 50) => {
    const order = await mk('sales/orders', {
      customerId: customer.id, channel: 'B2B', currency: 'EGP',
      items: [{ productId: product.id, quantity, unitPrice, discount: 0 }],
    });
    await mk(`sales/orders/${order.id}/confirm`, { version: order.version });
    return order;
  };
  /** Samples of `quantity` left at the shop. */
  const leave = (quantity: number) => mk('sales/orders', {
    samples: true, customerId: customer.id, channel: 'B2B', currency: 'EGP',
    items: [{ productId: product.id, quantity }],
  });
  /** The stock screen's reading of this product. */
  const stock = async () => {
    const body = await (await request.get(`${API}/inventory?productId=${product.id}`, { headers })).json();
    const row = (body.data ?? body)[0];
    return { shelf: Number(row.totalStock), atShops: Number(row.atShopsStock), all: Number(row.allStock) };
  };
  /** Units sold: what confirmed sales of this product drew. */
  const sold = () => Number(psqlQuery(`
    SELECT coalesce(sum(a.qty), 0) FROM sale_item_allocations a
      JOIN sale_items i ON i.id = a.sale_item_id JOIN sale_orders o ON o.id = i.sale_order_id
     WHERE i.product_id = '${product.id}' AND o.status IN ('CONFIRMED', 'PARTIALLY_PAID', 'PAID')`).trim());
  const preview = async () => {
    const res = await request.get(`${API}/settlements/preview/${cycle.id}`, { headers });
    expect(res.ok(), await res.text()).toBeTruthy();
    return (await res.json()).data;
  };
  return { headers, mk, cycle, po, product, customer, sell, leave, stock, sold, preview };
}

const dashOf = async (request: APIRequestContext, headers: any) =>
  (await (await request.get(`${API}/analytics/dashboard`, { headers })).json()).data;
const pnlOf = async (request: APIRequestContext, headers: any, query = '') => {
  const res = await request.get(`${API}/analytics/profit-and-loss${query}`, { headers });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()).data;
};
const errCode = async (res: { json(): Promise<any> }) => (await res.json())?.error?.code;

test.describe('Samples are not on the shelf and not sold (§4, samples at shops, 2026-10-18)', () => {
  test('TC-INV-75: every unit received is in exactly one place — shelf + at shops + sold = received — before and after the shop buys some', async ({ request }) => {
    const c = await shelfCycle(request, 'Inv Smp Count');
    const samples = await c.leave(3);
    await c.sell(2);
    let s = await c.stock();
    expect(s).toEqual({ shelf: 5, atShops: 3, all: 8 });
    expect(c.sold()).toBe(2);
    expect(s.shelf + s.atShops + c.sold()).toBe(10);
    // The three at the shop cannot be sold a second time from the shelf.
    const tooMany = await attempt(request, c.headers, 'sales/orders', {
      customerId: c.customer.id, channel: 'B2B', currency: 'EGP',
      items: [{ productId: c.product.id, quantity: 6, unitPrice: 50, discount: 0 }],
    });
    expect(tooMany.status, tooMany.message).toBe(400);

    // The shop keeps one of the three: two come back to the shelf, one is sold — once.
    const res = await request.post(`${API}/sales/orders/${samples.id}/samples/convert`, {
      headers: c.headers, data: { items: [{ productId: c.product.id, quantity: 1, unitPrice: 50 }] },
    });
    expect(res.ok(), await res.text()).toBeTruthy();
    s = await c.stock();
    expect(s).toEqual({ shelf: 7, atShops: 0, all: 7 });
    expect(c.sold()).toBe(3);
    expect(s.shelf + s.atShops + c.sold()).toBe(10);
  });

  test('TC-INV-76: samples written off cost their own cycle exactly their landed cost — in its settlement and in the P&L — and write no ledger row', async ({ request }) => {
    const c = await shelfCycle(request, 'Inv Smp WO');
    const other = await shelfCycle(request, 'Inv Smp WO Other');
    await c.sell(4); // 200 of sales at 40 of cost
    await other.sell(4);
    const samples = await c.leave(2); // 2 × 10 landed
    const ledgerBefore = Number(psqlQuery('SELECT count(*) FROM financial_transactions').trim());
    const dashBefore = await dashOf(request, c.headers);
    const pnlBefore = await pnlOf(request, c.headers);
    const otherBefore = await other.preview();

    const res = await request.post(`${API}/sales/orders/${samples.id}/samples/write-off`, { headers: c.headers, data: { reason: 'shop lost them' } });
    expect(res.ok(), await res.text()).toBeTruthy();

    const p = await c.preview();
    expect(cents(p.revenueEgp)).toBe(cents(200));
    expect(cents(p.cogsEgp)).toBe(cents(40));
    expect(cents(p.grossProfitEgp)).toBe(cents(140));
    const line = (p.costs as any[]).find((l) => l.category === 'samples_written_off');
    expect(line, JSON.stringify(p.costs)).toBeTruthy();
    expect(cents(line.amountEgp)).toBe(cents(20));
    // Nobody else's cycle carries it.
    expect((await other.preview()).grossProfitEgp).toBe(otherBefore.grossProfitEgp);

    const dashAfter = await dashOf(request, c.headers);
    expect(cents(dashBefore.netProfit) - cents(dashAfter.netProfit)).toBe(cents(20));
    expect(dashAfter.totalRevenue).toBe(dashBefore.totalRevenue);
    expect(dashAfter.totalCogs).toBe(dashBefore.totalCogs);
    const pnlAfter = await pnlOf(request, c.headers);
    const wo = (d: any) => cents((d.expensesByCategory as any[]).find((e) => e.category === 'samples_written_off')?.amountEgp ?? 0);
    expect(wo(pnlAfter) - wo(pnlBefore)).toBe(cents(20));
    expect(cents(pnlBefore.netProfitEgp) - cents(pnlAfter.netProfitEgp)).toBe(cents(20));
    expect(Number(psqlQuery('SELECT count(*) FROM financial_transactions').trim())).toBe(ledgerBefore);
  });

  test('TC-INV-77: samples out stop the settlement at every step — the plain transition, approve and pay — and the shop deciding lets it through', async ({ request }) => {
    const c = await shelfCycle(request, 'Inv Smp Gate');
    await c.sell(4);
    const out = await c.leave(2);
    const t = await request.post(`${API}/cycles/${c.cycle.id}/transition`, { headers: c.headers, data: { status: 'SETTLEMENT' } });
    expect(t.status()).toBe(400);
    expect(await errCode(t)).toBe('CYCLE_HAS_SAMPLES_OUT');
    await c.mk(`sales/orders/${out.id}/samples/return`, {});

    // A draft made while nothing was out; samples left afterwards stop the approval.
    const draft = await c.mk(`settlements/calculate/${c.cycle.id}`, {});
    const late = await c.leave(1);
    const approve = await request.post(`${API}/settlements/${draft.id}/approve`, { headers: c.headers, data: {} });
    expect(approve.status()).toBe(400);
    expect(await errCode(approve)).toBe('CYCLE_HAS_SAMPLES_OUT');
    await c.mk(`sales/orders/${late.id}/samples/return`, {});
    await c.mk(`settlements/${draft.id}/approve`, {});

    // Approved, then samples left: the payout stops on them before anything else.
    await c.leave(1);
    const pay = await request.post(`${API}/settlements/${draft.id}/pay`, { headers: c.headers, data: { acceptRemainingStock: true } });
    expect(pay.status()).toBe(400);
    expect(await errCode(pay)).toBe('CYCLE_HAS_SAMPLES_OUT');
    expect((await settlement(request, c.headers, draft.id)).status).toBe('APPROVED');
  });
});

test.describe('Funding stops changing once the split is agreed (§8, owner 2026-10-18)', () => {
  test('TC-INV-78: after approval — a contribution edit, Split equally, a new participant and removing a friend\'s payment are refused by FUNDING_LOCKED_AFTER_SETTLEMENT; recording one is refused too; nothing moves', async ({ request }) => {
    const { headers, mk, cycle, po, lender, partners, stamp } = await friendCycle(request, 'Inv Lock Appr');
    const f = await mk(`purchases/${po.id}/financings`, { lenderId: lender.id, amount: 30000 });
    await mk(`lender-financings/${f.id}/repayments`, { amountEgp: 390000, rateToEgp: 13 });
    const draft = await mk(`settlements/calculate/${cycle.id}`, {});
    await mk(`settlements/${draft.id}/approve`, {});

    const put = (id: string, data: any) => request.put(`${API}/cycles/participants/${id}`, { headers, data });
    const edit = await put(partners[0].id, { contributionAmount: 99999 });
    expect(edit.status()).toBe(400);
    const body = (await edit.json()).error;
    expect(body.code).toBe('FUNDING_LOCKED_AFTER_SETTLEMENT');
    expect(body.params.reason).toBe('SETTLEMENT_APPROVED');
    // "Split equally" is one equal edit per partner, down the same path.
    for (const p of partners) {
      expect(await errCode(await put(p.id, { contributionAmount: 13000 / partners.length }))).toBe('FUNDING_LOCKED_AFTER_SETTLEMENT');
    }
    const investor = await anInvestorUser(request, headers);
    const add = await request.post(`${API}/cycles/${cycle.id}/participants`, {
      headers, data: { participantType: 'TEMP_INVESTOR', investorUserId: investor.id, contributionAmount: 1000 },
    });
    expect(await errCode(add)).toBe('FUNDING_LOCKED_AFTER_SETTLEMENT');
    const remove = await request.post(`${API}/lender-financings/${f.id}/remove`, { headers, data: { reason: 'late change' } });
    expect(await errCode(remove)).toBe('FUNDING_LOCKED_AFTER_SETTLEMENT');
    // An approved cycle stands at Settlement, which closes it to friends'
    // payments before the funding lock is reached — refused either way.
    const second = await mk('lenders', { name: `Inv Lock Second ${stamp}` });
    const record = await request.post(`${API}/purchases/${po.id}/financings`, { headers, data: { lenderId: second.id, amount: 1 } });
    expect(record.status()).toBe(400);
    expect(['FUNDING_LOCKED_AFTER_SETTLEMENT', 'CYCLE_CLOSED_FOR_FINANCING']).toContain(await errCode(record));

    const now = (await (await request.get(`${API}/cycles/${cycle.id}`, { headers })).json()).data;
    expect(now.participants.length).toBe(partners.length);
    for (const p of partners) {
      const was = p.id === partners[partners.length - 1].id ? 13000 - 4333.33 * (partners.length - 1) : 4333.33;
      expect(cents(now.participants.find((x: any) => x.id === p.id).contributionAmount)).toBe(cents(was));
    }
  });

  test('TC-INV-79: paid and closed — funding is locked; reversing the settlement opens it again', async ({ request }) => {
    const { headers } = await apiCtx(request);
    const a = (await usersByEmail(request, headers))('partner.a@motoparts.com');
    const { mk, cycle } = await soldOutCycle(request, 'Inv Lock Paid', [[a.id, 'CORE_PARTNER', 1000]]);
    const id = await approved(mk, cycle.id);
    const pay = await request.post(`${API}/settlements/${id}/pay`, { headers, data: {} });
    expect(pay.ok(), await pay.text()).toBeTruthy();
    const detail = (await (await request.get(`${API}/cycles/${cycle.id}`, { headers })).json()).data;
    const mine = detail.participants.find((p: any) => p.partnerUserId === a.id);
    const edit = await request.put(`${API}/cycles/participants/${mine.id}`, { headers, data: { contributionAmount: 2000 } });
    expect(edit.status()).toBe(400);
    const err = (await edit.json()).error;
    expect(err.code).toBe('FUNDING_LOCKED_AFTER_SETTLEMENT');
    expect(['SETTLEMENT_PAID', 'CYCLE_CLOSED']).toContain(err.params.reason);

    const rev = await request.post(`${API}/settlements/${id}/reverse`, { headers, data: { reason: 'paid the wrong figures' } });
    expect(rev.ok(), await rev.text()).toBeTruthy();
    const open = await request.put(`${API}/cycles/participants/${mine.id}`, { headers, data: { contributionAmount: 2000 } });
    expect(open.ok(), await open.text()).toBeTruthy();
  });

  test('TC-INV-80: a draft calculated before the funding changed cannot be approved (SETTLEMENT_STALE_FUNDING); calculated again, it can', async ({ request }) => {
    const { headers } = await apiCtx(request);
    const user = await usersByEmail(request, headers);
    const a = user('partner.a@motoparts.com');
    const b = user('partner.b@motoparts.com');
    const { mk, cycle } = await soldOutCycle(request, 'Inv Stale', [[a.id, 'CORE_PARTNER', 500], [b.id, 'CORE_PARTNER', 500]]);
    const draft = await mk(`settlements/calculate/${cycle.id}`, {});
    const detail = (await (await request.get(`${API}/cycles/${cycle.id}`, { headers })).json()).data;
    const pa = detail.participants.find((p: any) => p.partnerUserId === a.id);
    const edit = await request.put(`${API}/cycles/participants/${pa.id}`, { headers, data: { contributionAmount: 900 } });
    expect(edit.ok(), await edit.text()).toBeTruthy();
    const stale = await request.post(`${API}/settlements/${draft.id}/approve`, { headers, data: {} });
    expect(stale.status()).toBe(400);
    expect(await errCode(stale)).toBe('SETTLEMENT_STALE_FUNDING');
    expect((await settlement(request, headers, draft.id)).status).toBe('DRAFT');
    const fresh = await mk(`settlements/calculate/${cycle.id}`, {});
    await mk(`settlements/${fresh.id}/approve`, {});
    expect((await settlement(request, headers, fresh.id)).status).toBe('APPROVED');
  });
});

test.describe('The profit and loss is the dashboard\'s own figures (owner 2026-10-18)', () => {
  test('TC-INV-81: with no period the P&L equals the dashboard exactly, and its buckets add up to the totals', async ({ request }) => {
    // Something to count, so a zero cannot hide a disagreement (rule 10).
    const c = await shelfCycle(request, 'Inv PnL');
    await c.sell(3, 70);
    const dash = await dashOf(request, c.headers);
    const pnl = await pnlOf(request, c.headers);
    expect(pnl.allTime).toBe(true);
    expect(pnl.netProfitEgp).not.toBe(0);
    expect(pnl.salesEgp).toBe(dash.totalRevenue);
    expect(pnl.cogsEgp).toBe(dash.totalCogs);
    expect(pnl.expensesEgp).toBe(dash.totalExpenses);
    expect(pnl.recoveredEgp).toBe(dash.totalRecoveredEgp);
    expect(pnl.otherIncomeEgp).toBe(dash.totalOtherIncomeEgp);
    expect(pnl.exchangeDifferenceEgp).toBe(dash.exchangeDifferenceEgp);
    expect(pnl.netProfitEgp).toBe(dash.netProfit);
    // `buckets` since the P&L redesign (days, weeks or months); `months` before it.
    const parts: any[] = pnl.buckets ?? pnl.months;
    expect(parts.length).toBeGreaterThan(0);
    const sum = (k: string) => parts.reduce((s, b) => s + cents(b[k] ?? 0), 0);
    expect(sum('netProfitEgp')).toBe(cents(pnl.netProfitEgp));
    if (parts[0].salesEgp !== undefined) expect(sum('salesEgp')).toBe(cents(pnl.salesEgp));
    if (parts[0].expensesEgp !== undefined) expect(sum('expensesEgp')).toBe(cents(pnl.expensesEgp));
  });
});

test.describe('A default price is a suggestion, never a set price (§3, owner 2026-10-18)', () => {
  test('TC-INV-82: selling at the default (landed + 20%) or at any other price saves the line\'s price and writes no ProductPrice row; the default stays a default', async ({ request }) => {
    const c = await shelfCycle(request, 'Inv DefPrice');
    const listed = async () => (await (await request.get(`${API}/products/${c.product.id}`, { headers: c.headers })).json()).data.listPrices;
    const before = await listed();
    expect(before.B2B).toMatchObject({ amount: '12.00', source: 'DEFAULT' });

    const atDefault = await c.sell(2, 12);
    const atOther = await c.sell(1, 15);
    const lineOf = async (id: string) => (await (await request.get(`${API}/sales/orders/${id}`, { headers: c.headers })).json()).data.items[0];
    expect(Number((await lineOf(atDefault.id)).unitPrice)).toBe(12);
    expect(Number((await lineOf(atOther.id)).unitPrice)).toBe(15);
    expect(Number(psqlQuery(`SELECT count(*) FROM product_prices WHERE product_id = '${c.product.id}'`).trim())).toBe(0);
    const after = await listed();
    expect(after.B2B.source).toBe('DEFAULT');
    expect(after.B2C?.source ?? 'DEFAULT').toBe('DEFAULT');
  });
});

test.describe('A cancelled order owes nothing and counts in nothing (§4, fixed 2026-10-18)', () => {
  test('TC-INV-83: cancelled after confirming — outstanding 0, the shop owes nothing, revenue, cost, receivables and profit are as before, and it cannot be paid', async ({ request }) => {
    const c = await shelfCycle(request, 'Inv Cancel');
    const owes = async () => Number((await (await request.get(`${API}/customers/${c.customer.id}`, { headers: c.headers })).json()).data.outstandingBalance);
    const dashBefore = await dashOf(request, c.headers);
    const order = await c.sell(2, 250);
    const confirmed = (await (await request.get(`${API}/sales/orders/${order.id}`, { headers: c.headers })).json()).data;
    expect(Number(confirmed.outstanding)).toBe(500);
    expect(await owes()).toBe(500);

    await c.mk(`sales/orders/${order.id}/cancel`, {});
    const after = (await (await request.get(`${API}/sales/orders/${order.id}`, { headers: c.headers })).json()).data;
    expect(after.status).toBe('CANCELLED');
    expect(Number(after.outstanding)).toBe(0);
    expect(await owes()).toBe(0);
    const dashAfter = await dashOf(request, c.headers);
    for (const k of ['totalRevenue', 'totalCogs', 'receivables', 'netProfit']) {
      expect(dashAfter[k], k).toBe(dashBefore[k]);
    }
    expect((await c.stock()).shelf).toBe(10);
    const pay = await request.post(`${API}/payments`, {
      headers: c.headers,
      data: { customerId: c.customer.id, amount: 10, currency: 'EGP', method: 'CASH', orderId: order.id },
    });
    expect(pay.status()).toBe(400);
  });
});
