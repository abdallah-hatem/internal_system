/* eslint-disable @typescript-eslint/no-explicit-any -- API responses are parsed JSON; each assertion names the field it checks */
/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: Receiving stock one delivery at a time (plan B3)
 * ═══════════════════════════════════════════════════════════════════════
 *  Each delivery that reaches Egypt is counted into stock as its own batch,
 *  with its own arrival date, at the same landed cost per unit ORDERED
 *  whichever delivery brought it (BUSINESS_LOGIC §2, §3, §14 — 2026-10-10).
 *  The first receipt walks the cycle on to Selling. A cycle settles only once
 *  every unit is received or marked lost (§8).
 *
 *  Every case here is also a unit test in
 *  apps/api/src/modules/inventory/receipts.spec.ts under the same name; this
 *  suite is the same rules through the real API and database. The race is also
 *  run against real Postgres in receipts.db.spec.ts.
 *
 *  Not covered here, and why:
 *  - Settlement profit with a loss, and settlement approve: calculating needs
 *    recorded contributions and a selling flow; the unit suite covers both,
 *    and 34 TC-INV-19 covers the transition gate end to end.
 *  - FIFO by receipt date: needs two receipts days apart; the unit suite fakes
 *    the clock.
 */
import { test, expect, APIRequestContext } from '@playwright/test';
import { apiCtx, API, daysAgo } from './support/fixtures';

type Headers = Record<string, string>;

async function accountWithRole(request: APIRequestContext, role: string) {
  const { headers } = await apiCtx(request);
  const stamp = `${Date.now()}${Math.floor(performance.now() % 1000)}`;
  const email = `receipts-${role.toLowerCase()}-${stamp}@motoparts.com`;
  const made = await request.post(`${API}/auth/register`, {
    headers,
    data: { email, password: 'password123', displayName: `Receipts ${stamp}`, role },
  });
  expect(made.ok(), `create ${role}: ${await made.text()}`).toBeTruthy();
  const signedIn = await request.post(`${API}/auth/login`, {
    data: { email, password: 'password123' },
  });
  return { Authorization: `Bearer ${(await signedIn.json()).data.accessToken}` };
}

/**
 * 40 of one product ordered at 100, its legs departed 20 days ago, nothing
 * arrived. The leg costs 400, so a unit lands at 110 on a UAE-direct cycle.
 */
async function departedCycle(
  request: APIRequestContext,
  route: 'UAE_DIRECT' | 'CHINA' = 'UAE_DIRECT',
) {
  const { headers, mk } = await apiCtx(request);
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const product = await mk('products', { name: `Rcpt ${stamp} Part`, minStock: 0 });
  const supplier = await mk('suppliers', { name: `Rcpt ${stamp} Supplier`, country: 'AE' });
  const cycle = await mk('cycles', { originType: route, currency: 'EGP' });
  await mk(`cycles/${cycle.id}/purchases`, {
    supplierId: supplier.id, currency: 'EGP', fxRateToEgp: 1, orderedOn: daysAgo(25),
    items: [{ productId: product.id, orderedQty: 40, unitPrice: 100 }],
  });
  const legs =
    route === 'CHINA'
      ? [
          await mk(`cycles/${cycle.id}/shipping-legs`, {
            sequence: 1, origin: 'Guangzhou, CN', destination: 'Dubai, UAE',
            costBasis: 'FLAT', amount: 400, currency: 'EGP', fxRateToEgp: 1,
            departedOn: daysAgo(20),
          }),
          await mk(`cycles/${cycle.id}/shipping-legs`, {
            sequence: 2, origin: 'Dubai, UAE', destination: 'Cairo, Egypt',
            costBasis: 'FLAT', amount: 0, currency: 'EGP', fxRateToEgp: 1,
            departedOn: daysAgo(12),
          }),
        ]
      : [
          await mk(`cycles/${cycle.id}/shipping-legs`, {
            sequence: 1, origin: 'Dubai, UAE', destination: 'Cairo, Egypt',
            costBasis: 'FLAT', amount: 400, currency: 'EGP', fxRateToEgp: 1,
            departedOn: daysAgo(20),
          }),
        ];
  const full = await (await request.get(`${API}/cycles/${cycle.id}`, { headers })).json();
  const item = (full.data ?? full).purchaseOrders[0].items[0];
  return { headers, mk, cycle, product, legs, leg: legs[legs.length - 1], item };
}

async function post(request: APIRequestContext, headers: Headers, path: string, data: unknown) {
  const res = await request.post(`${API}/${path}`, { headers, data });
  const body = await res.json().catch(() => ({}));
  return { status: res.status(), body, data: body?.data, code: body?.error?.code, params: body?.error?.params };
}

async function deliver(request: APIRequestContext, headers: Headers, legId: string, item: { id: string }, qty: number, arrivedOn = daysAgo(5)) {
  const r = await post(request, headers, `shipping/legs/${legId}/deliveries`, {
    arrivedOn, lines: [{ purchaseOrderItemId: item.id, qty }],
  });
  expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
  return r.data;
}

/** Walk the cycle to Arrived Egypt — possible once the last leg has a delivery. */
async function toArrivedEgypt(mk: any, cycle: { id: string }, route: 'UAE_DIRECT' | 'CHINA' = 'UAE_DIRECT') {
  const walk = route === 'CHINA'
    ? ['FUNDING', 'PURCHASING', 'IN_TRANSIT', 'ARRIVED_UAE', 'IN_TRANSIT_TO_EGYPT', 'ARRIVED_EGYPT']
    : ['FUNDING', 'PURCHASING', 'ARRIVED_UAE', 'IN_TRANSIT_TO_EGYPT', 'ARRIVED_EGYPT'];
  for (const status of walk) await mk(`cycles/${cycle.id}/transition`, { status });
}

const receive = (request: APIRequestContext, headers: Headers, cycleId: string, delivery: any, qty: number, extra: Record<string, unknown> = {}) =>
  post(request, headers, 'receipts/verify', {
    cycleId, deliveryId: delivery.id,
    items: [{ deliveryLineId: delivery.lines[0].id, receivedQty: qty, ...extra }],
  });

async function batchesOf(request: APIRequestContext, headers: Headers, productId: string) {
  const body = await (await request.get(`${API}/inventory?productId=${productId}`, { headers })).json();
  const row = (body.data ?? []).find((p: any) => p.productId === productId);
  return (row?.batches ?? []) as any[];
}

async function cycleOf(request: APIRequestContext, headers: Headers, id: string) {
  const body = await (await request.get(`${API}/cycles/${id}`, { headers })).json();
  return body.data ?? body;
}

test.describe('POST /receipts/verify', () => {
  test('TC-RCV-01: Deliveries 15 then 10 received → two batches, same landed unit cost, both sellable', async ({ request }) => {
    const { headers, mk, cycle, leg, item, product } = await departedCycle(request);
    const first = await deliver(request, headers, leg.id, item, 15, daysAgo(10));
    await toArrivedEgypt(mk, cycle);
    expect((await receive(request, headers, cycle.id, first, 15)).status).toBeLessThan(300);
    const second = await deliver(request, headers, leg.id, item, 10, daysAgo(4));
    expect((await receive(request, headers, cycle.id, second, 10)).status).toBeLessThan(300);

    const batches = await batchesOf(request, headers, product.id);
    expect(batches.map((b) => Number(b.landedUnitCostEgp))).toEqual([110, 110]);
    expect(batches.map((b) => Number(b.saleableQty))).toEqual([15, 10]);
  });

  test('TC-RCV-02: Unit cost: 40 ordered, goods 4,000, shipping 400 → 110.00 per unit for every batch, not 4,400 / received', async ({ request }) => {
    const { headers, mk, cycle, leg, item, product } = await departedCycle(request);
    const d = await deliver(request, headers, leg.id, item, 12);
    await toArrivedEgypt(mk, cycle);
    await receive(request, headers, cycle.id, d, 12);
    const [batch] = await batchesOf(request, headers, product.id);
    expect(Number(batch.landedUnitCostEgp)).toBeCloseTo(110, 4);

    const landed = await (await request.get(`${API}/costing/cycles/${cycle.id}/landed-cost`, { headers })).json();
    expect((landed.data ?? landed).items[0].landedUnitCostEgp).toBe('110.0000');
  });

  test('TC-RCV-03: Received 14 of a delivery of 15 → batch 14; 1 is waiting to be received against that delivery', async ({ request }) => {
    const { headers, mk, cycle, leg, item } = await departedCycle(request);
    const d = await deliver(request, headers, leg.id, item, 15);
    await toArrivedEgypt(mk, cycle);
    await receive(request, headers, cycle.id, d, 14);
    const s = (await (await request.get(`${API}/cycles/${cycle.id}/shipment`, { headers })).json()).data;
    expect(s.lines[0]).toEqual(expect.objectContaining({ received: 14, waiting: 1, onTheWay: 25 }));
  });

  test('TC-RCV-04: Receive 16 of a delivery of 15 → RECEIVED_EXCEEDS_DELIVERED', async ({ request }) => {
    const { headers, mk, cycle, leg, item, product } = await departedCycle(request);
    const d = await deliver(request, headers, leg.id, item, 15);
    await toArrivedEgypt(mk, cycle);
    const r = await receive(request, headers, cycle.id, d, 16);
    expect(r.code).toBe('RECEIVED_EXCEEDS_DELIVERED');
    expect(await batchesOf(request, headers, product.id)).toHaveLength(0);
  });

  test('TC-RCV-05: Receive 14 of a delivery of 15, then the 1 later → a second batch; a third receipt → STOCK_ALREADY_VERIFIED', async ({ request }) => {
    const { headers, mk, cycle, leg, item, product } = await departedCycle(request);
    const d = await deliver(request, headers, leg.id, item, 15);
    await toArrivedEgypt(mk, cycle);
    await receive(request, headers, cycle.id, d, 14);
    expect((await receive(request, headers, cycle.id, d, 1)).status).toBeLessThan(300);
    expect((await receive(request, headers, cycle.id, d, 1)).code).toBe('STOCK_ALREADY_VERIFIED');
    expect(await batchesOf(request, headers, product.id)).toHaveLength(2);
  });

  // Since L3 (§1, 2026-10-11) a last-leg delivery moves the cycle to Arrived
  // Egypt by itself, so a cycle in transit holding one can no longer be built
  // through the API; the CYCLE_NOT_ARRIVED guard stays for cycles left behind
  // by data from before, and is pinned in receipts.spec.ts.
  test('TC-RCV-06: A last-leg delivery puts the cycle at Arrived Egypt, so it can be received straight away', async ({ request }) => {
    const { headers, cycle, leg, item } = await departedCycle(request);
    expect((await cycleOf(request, headers, cycle.id)).status).toBe('IN_TRANSIT_TO_EGYPT');
    const d = await deliver(request, headers, leg.id, item, 15);
    expect((await cycleOf(request, headers, cycle.id)).status).toBe('ARRIVED_EGYPT');
    expect((await receive(request, headers, cycle.id, d, 15)).status).toBeLessThan(300);
    expect((await cycleOf(request, headers, cycle.id)).status).toBe('SELLING');
  });

  test('TC-RCV-07: The first receipt walks ARRIVED_EGYPT → VERIFICATION → SELLING; a later delivery is received in SELLING', async ({ request }) => {
    const { headers, mk, cycle, leg, item } = await departedCycle(request);
    const d = await deliver(request, headers, leg.id, item, 15, daysAgo(10));
    await toArrivedEgypt(mk, cycle);
    await receive(request, headers, cycle.id, d, 15);
    expect((await cycleOf(request, headers, cycle.id)).status).toBe('SELLING');

    const later = await deliver(request, headers, leg.id, item, 10, daysAgo(2));
    expect((await receive(request, headers, cycle.id, later, 10)).status).toBeLessThan(300);
    // The order line's received quantity is the sum of its batches.
    const line = (await cycleOf(request, headers, cycle.id)).purchaseOrders[0].items[0];
    expect(Number(line.receivedQty)).toBe(25);
  });

  test('TC-RCV-08: Receive a leg-1 (UAE) delivery into stock → NOT_LAST_LEG_DELIVERY', async ({ request }) => {
    const { headers, mk, cycle, legs, item } = await departedCycle(request, 'CHINA');
    const uae = await deliver(request, headers, legs[0].id, item, 40, daysAgo(15));
    await deliver(request, headers, legs[1].id, item, 40, daysAgo(5));
    await toArrivedEgypt(mk, cycle, 'CHINA');
    expect((await receive(request, headers, cycle.id, uae, 40)).code).toBe('NOT_LAST_LEG_DELIVERY');
  });

  test('TC-RCV-09: A delivery from another cycle → 404', async ({ request }) => {
    const mine = await departedCycle(request);
    const theirs = await departedCycle(request);
    await deliver(request, mine.headers, mine.leg.id, mine.item, 15);
    await toArrivedEgypt(mine.mk, mine.cycle);
    const theirDelivery = await deliver(request, theirs.headers, theirs.leg.id, theirs.item, 15);
    const r = await receive(request, mine.headers, mine.cycle.id, theirDelivery, 15);
    expect(r.status).toBe(404);
    expect(r.code).toBe('NOT_FOUND');
  });

  test('TC-RCV-10: Receiving 0 → no batch; negative qty or negative landed cost → refused', async ({ request }) => {
    const { headers, mk, cycle, leg, item, product } = await departedCycle(request);
    const d = await deliver(request, headers, leg.id, item, 15);
    await toArrivedEgypt(mk, cycle);
    expect((await receive(request, headers, cycle.id, d, 0)).code).toBe('QTY_NOT_POSITIVE');
    expect((await receive(request, headers, cycle.id, d, -1)).code).toBe('QTY_NOT_POSITIVE');
    expect((await receive(request, headers, cycle.id, d, 5, { landedUnitCostEgp: -1 })).code).toBe('VALIDATION_FAILED');
    expect(await batchesOf(request, headers, product.id)).toHaveLength(0);
  });

  test('TC-RCV-11: Two receipts of one delivery line at once that exceed it together → one succeeds, the other gets a coded refusal, not a 500', async ({ request }) => {
    const { headers, mk, cycle, leg, item, product } = await departedCycle(request);
    const d = await deliver(request, headers, leg.id, item, 15);
    await toArrivedEgypt(mk, cycle);
    const [a, b] = await Promise.all([
      receive(request, headers, cycle.id, d, 10),
      receive(request, headers, cycle.id, d, 10),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses[0]).toBeLessThan(300);
    expect(statuses[1]).toBe(400);
    expect([a.code, b.code]).toContain('RECEIVED_EXCEEDS_DELIVERED');
    expect((await batchesOf(request, headers, product.id)).map((x) => Number(x.receivedQty))).toEqual([10]);
  });

  test('TC-RCV-12: The old body with two deliveries waiting → DELIVERY_REQUIRED; with one → works', async ({ request }) => {
    const { headers, mk, cycle, leg, item, product } = await departedCycle(request);
    await deliver(request, headers, leg.id, item, 15, daysAgo(10));
    await deliver(request, headers, leg.id, item, 10, daysAgo(5));
    await toArrivedEgypt(mk, cycle);
    const old = (qty: number) => post(request, headers, 'receipts/verify', {
      cycleId: cycle.id, items: [{ purchaseOrderItemId: item.id, productId: product.id, receivedQty: qty }],
    });
    expect((await old(15)).code).toBe('DELIVERY_REQUIRED');

    const single = await departedCycle(request);
    await deliver(request, single.headers, single.leg.id, single.item, 40);
    await toArrivedEgypt(single.mk, single.cycle);
    const ok = await post(request, single.headers, 'receipts/verify', {
      cycleId: single.cycle.id, items: [{ purchaseOrderItemId: single.item.id, receivedQty: 40 }],
    });
    expect(ok.status, JSON.stringify(ok.body)).toBeLessThan(300);
  });

  test('TC-RCV-13: An investor or shop token on POST /receipts/verify → refused with a code', async ({ request }) => {
    const { headers, mk, cycle, leg, item } = await departedCycle(request);
    const d = await deliver(request, headers, leg.id, item, 15);
    await toArrivedEgypt(mk, cycle);
    const investor = await accountWithRole(request, 'TEMP_INVESTOR');
    const r = await receive(request, investor, cycle.id, d, 15);
    expect(r.status).toBe(403);
    expect(r.code).toBe('ROLE_NOT_ALLOWED');
  });
});

test.describe('around receiving', () => {
  test('TC-RCV-20: With 5 on the way, the plain transition SELLING → SETTLEMENT → SHIPMENT_NOT_ACCOUNTED; after marking them lost → allowed', async ({ request }) => {
    const { headers, mk, cycle, leg, item } = await departedCycle(request);
    const d = await deliver(request, headers, leg.id, item, 35);
    await toArrivedEgypt(mk, cycle);
    await receive(request, headers, cycle.id, d, 35);
    const r = await post(request, headers, `cycles/${cycle.id}/transition`, { status: 'SETTLEMENT' });
    expect(r.code).toBe('SHIPMENT_NOT_ACCOUNTED');
    expect(r.params).toEqual(expect.objectContaining({ onTheWay: 5, lines: 1 }));

    await mk(`shipping/legs/${leg.id}/losses`, { lines: [{ purchaseOrderItemId: item.id, qty: 5 }] });
    const ok = await post(request, headers, `cycles/${cycle.id}/transition`, { status: 'SETTLEMENT' });
    expect(ok.status, JSON.stringify(ok.body)).toBeLessThan(300);
  });

  test('TC-RCV-21: PUT /purchases/items/:id with receivedQty → refused', async ({ request }) => {
    const { headers, item } = await departedCycle(request);
    const res = await request.put(`${API}/purchases/items/${item.id}`, { headers, data: { receivedQty: 40 } });
    expect(res.status()).toBe(400);
    expect((await res.json()).error.code).toBe('VALIDATION_FAILED');
  });

  test('TC-RCV-22: Inventory shows each batch’s own Arrived date; two deliveries → two dates; never leg 1’s date', async ({ request }) => {
    const { headers, mk, cycle, legs, item, product } = await departedCycle(request, 'CHINA');
    await deliver(request, headers, legs[0].id, item, 40, daysAgo(15));
    const first = await deliver(request, headers, legs[1].id, item, 15, daysAgo(8));
    await toArrivedEgypt(mk, cycle, 'CHINA');
    await receive(request, headers, cycle.id, first, 15);
    const second = await deliver(request, headers, legs[1].id, item, 10, daysAgo(3));
    await receive(request, headers, cycle.id, second, 10);

    const dates = (await batchesOf(request, headers, product.id)).map((b) => String(b.arrivedOn).slice(0, 10));
    expect(dates).toEqual([daysAgo(8), daysAgo(3)]);
    expect(dates).not.toContain(daysAgo(15));
  });
});
