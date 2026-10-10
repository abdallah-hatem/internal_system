/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: Recording deliveries and losses (plan B2)
 * ═══════════════════════════════════════════════════════════════════════
 *  Goods leave in one shipment and arrive in deliveries, weeks apart
 *  (BUSINESS_LOGIC §1, 2026-10-10). A partner records each delivery, and can
 *  mark what is still to come as lost — a loss on the cycle, not a ledger row
 *  (§2, §9). The cycle can move on as soon as some goods reach a point.
 *
 *  Every case here is also a unit test in
 *  apps/api/src/modules/shipping/deliveries.service.spec.ts, under the same
 *  name; this suite is the same rules through the real API and database. The
 *  race is also run against real Postgres in deliveries.db.spec.ts.
 *
 *  Not covered here, and why:
 *  - A delivery on a cycle in SETTLEMENT/CLOSED: reaching settlement needs a
 *    whole selling flow; the unit suite covers it.
 *  - check-data after a partial flow: the script needs the database container;
 *    it was run against a throwaway database (docs/build-log/.../B2.md).
 */
import { test, expect, APIRequestContext } from '@playwright/test';
import { apiCtx, API, daysAgo, today, refusedCallers } from './support/fixtures';

type Headers = Record<string, string>;

/**
 * A cycle with 40 of one product ordered at 100 and its legs departed 20 days
 * ago, nothing arrived. UAE-direct has one leg; China has two. The leg costs
 * 400, so a unit lands at 110 on a UAE-direct cycle.
 */
async function departedCycle(
  request: APIRequestContext,
  route: 'UAE_DIRECT' | 'CHINA' = 'UAE_DIRECT',
) {
  const { headers, mk } = await apiCtx(request);
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const product = await mk('products', { name: `Deliv ${stamp} Part`, minStock: 0 });
  const supplier = await mk('suppliers', { name: `Deliv ${stamp} Supplier`, country: 'AE' });
  const cycle = await mk('cycles', { originType: route, currency: 'EGP' });
  const po = await mk(`cycles/${cycle.id}/purchases`, {
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
            departedOn: daysAgo(10),
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
  return { headers, mk, cycle, product, po, legs, leg: legs[0], item };
}

const lines = (item: { id: string }, qty: number) => [{ purchaseOrderItemId: item.id, qty }];

async function post(request: APIRequestContext, headers: Headers, path: string, data: unknown) {
  const res = await request.post(`${API}/${path}`, { headers, data });
  const body = await res.json().catch(() => ({}));
  return { status: res.status(), body, code: body?.error?.code, params: body?.error?.params };
}

const deliver = (request: APIRequestContext, headers: Headers, legId: string, item: { id: string }, qty: number, arrivedOn = daysAgo(5)) =>
  post(request, headers, `shipping/legs/${legId}/deliveries`, { arrivedOn, lines: lines(item, qty) });

const lose = (request: APIRequestContext, headers: Headers, legId: string, item: { id: string }, qty: number) =>
  post(request, headers, `shipping/legs/${legId}/losses`, { lines: lines(item, qty) });

async function shipment(request: APIRequestContext, headers: Headers, cycleId: string) {
  return (await (await request.get(`${API}/cycles/${cycleId}/shipment`, { headers })).json()).data;
}

const tomorrow = () => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
};

test.describe('POST /shipping/legs/:id/deliveries', () => {
  test('TC-DL-01: Delivery of 41 when 40 are on the way → DELIVERY_EXCEEDS_IN_TRANSIT, nothing written', async ({ request }) => {
    const { headers, cycle, leg, item } = await departedCycle(request);
    const r = await deliver(request, headers, leg.id, item, 41);
    expect(r.status).toBe(400);
    expect(r.code).toBe('DELIVERY_EXCEEDS_IN_TRANSIT');
    expect(r.params).toEqual(expect.objectContaining({ onTheWay: 40, asked: 41 }));
    const s = await shipment(request, headers, cycle.id);
    expect(s.legs[0].delivered).toBe(0);
    expect(s.legs[0].deliveries).toHaveLength(0);
  });

  test('TC-DL-02: Deliveries 15, 10, 5, 10 → all accepted; the fifth (1 more) → refused', async ({ request }) => {
    const { headers, cycle, leg, item } = await departedCycle(request);
    for (const [qty, day] of [[15, 15], [10, 10], [5, 6], [10, 3]] as const) {
      const r = await deliver(request, headers, leg.id, item, qty, daysAgo(day));
      expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    }
    const fifth = await deliver(request, headers, leg.id, item, 1, daysAgo(1));
    expect(fifth.code).toBe('DELIVERY_EXCEEDS_IN_TRANSIT');

    const s = await shipment(request, headers, cycle.id);
    expect(s.legs[0].delivered).toBe(40);
    expect(s.legs[0].status).toBe('ARRIVED');
    // The stored leg agrees with the position (the list screens read it).
    const legs = (await (await request.get(`${API}/cycles/${cycle.id}/shipping-legs`, { headers })).json()).data;
    expect(legs[0].status).toBe('ARRIVED');
    expect(legs[0].arrivedOn.slice(0, 10)).toBe(daysAgo(3));
  });

  test('TC-DL-03: Leg 2 delivery larger than leg 1 has delivered so far → refused', async ({ request }) => {
    const { headers, legs, item } = await departedCycle(request, 'CHINA');
    expect((await deliver(request, headers, legs[0].id, item, 30, daysAgo(12))).status).toBeLessThan(300);
    const r = await deliver(request, headers, legs[1].id, item, 31, daysAgo(5));
    expect(r.code).toBe('DELIVERY_EXCEEDS_IN_TRANSIT');
    expect(r.params.onTheWay).toBe(30);
  });

  test('TC-DL-04: Delivery dated tomorrow → DATE_IN_FUTURE', async ({ request }) => {
    const { headers, leg, item } = await departedCycle(request);
    expect((await deliver(request, headers, leg.id, item, 5, tomorrow())).code).toBe('DATE_IN_FUTURE');
    // Today is fine.
    expect((await deliver(request, headers, leg.id, item, 5, today())).status).toBeLessThan(300);
  });

  test('TC-DL-05: Delivery dated before the leg departed → DELIVERY_BEFORE_DEPARTURE', async ({ request }) => {
    const { headers, leg, item } = await departedCycle(request);
    expect((await deliver(request, headers, leg.id, item, 5, daysAgo(21))).code).toBe('DELIVERY_BEFORE_DEPARTURE');
  });

  test('TC-DL-06: Delivery on a leg not yet departed → LEG_NOT_DEPARTED', async ({ request }) => {
    const { headers, mk, product, po } = await departedCycle(request);
    const c = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'EGP' });
    await mk(`cycles/${c.id}/purchases`, {
      supplierId: po.supplierId, currency: 'EGP', fxRateToEgp: 1, orderedOn: today(),
      items: [{ productId: product.id, orderedQty: 5, unitPrice: 10 }],
    });
    const undated = await mk(`cycles/${c.id}/shipping-legs`, {
      sequence: 1, origin: 'Dubai, UAE', destination: 'Cairo, Egypt', costBasis: 'FLAT', amount: 0,
    });
    const full = await (await request.get(`${API}/cycles/${c.id}`, { headers })).json();
    const item = (full.data ?? full).purchaseOrders[0].items[0];
    expect((await deliver(request, headers, undated.id, item, 1)).code).toBe('LEG_NOT_DEPARTED');
  });

  test('TC-DL-07: Delivery or loss on a CANCELLED cycle → CYCLE_CLOSED', async ({ request }) => {
    const { headers, mk, cycle, leg, item } = await departedCycle(request);
    await mk(`cycles/${cycle.id}/transition`, { status: 'CANCELLED' });
    expect((await deliver(request, headers, leg.id, item, 5)).code).toBe('CYCLE_CLOSED');
    expect((await lose(request, headers, leg.id, item, 5)).code).toBe('CYCLE_CLOSED');
  });

  test('TC-DL-08: qty 0 or negative → QTY_NOT_POSITIVE', async ({ request }) => {
    const { headers, leg, item } = await departedCycle(request);
    for (const qty of [0, -5]) {
      expect((await deliver(request, headers, leg.id, item, qty)).code).toBe('QTY_NOT_POSITIVE');
      expect((await lose(request, headers, leg.id, item, qty)).code).toBe('QTY_NOT_POSITIVE');
    }
  });

  test("TC-DL-09: A line from another cycle's order → 404 purchaseOrderItem, not 500", async ({ request }) => {
    const { headers, leg } = await departedCycle(request);
    const other = await departedCycle(request);
    const r = await deliver(request, headers, leg.id, other.item, 5);
    expect(r.status).toBe(404);
    expect(r.params).toEqual({ entity: 'purchaseOrderItem' });
    const l = await lose(request, headers, leg.id, other.item, 5);
    expect(l.status).toBe(404);
  });

  test('TC-DL-10: The same line twice, or no lines → VALIDATION_FAILED', async ({ request }) => {
    const { headers, leg, item } = await departedCycle(request);
    const twice = await post(request, headers, `shipping/legs/${leg.id}/deliveries`, {
      arrivedOn: daysAgo(5),
      lines: [...lines(item, 5), ...lines(item, 5)],
    });
    expect(twice.code).toBe('VALIDATION_FAILED');
    const none = await post(request, headers, `shipping/legs/${leg.id}/deliveries`, {
      arrivedOn: daysAgo(5), lines: [],
    });
    expect(none.code).toBe('VALIDATION_FAILED');
  });

  test('TC-DL-11: Unknown leg id → 404', async ({ request }) => {
    const { headers, item } = await departedCycle(request);
    for (const id of ['00000000-0000-4000-8000-000000000000', 'not-a-leg']) {
      const r = await deliver(request, headers, id, item, 5);
      expect(r.status).toBe(404);
    }
  });

  test('TC-DL-12: Two deliveries sent at once that together exceed what is on the way → exactly one succeeds', async ({ request }) => {
    const { headers, cycle, leg, item } = await departedCycle(request);
    const [a, b] = await Promise.all([
      deliver(request, headers, leg.id, item, 30),
      deliver(request, headers, leg.id, item, 30),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses[0]).toBeLessThan(300);
    expect(statuses[1]).toBe(400); // a coded refusal, never a 500
    expect([a.code, b.code]).toContain('DELIVERY_EXCEEDS_IN_TRANSIT');
    expect((await shipment(request, headers, cycle.id)).legs[0].delivered).toBe(30);
  });

  test('TC-DL-13: A delivery dated today → accepted (the day is Cairo\'s, not UTC\'s)', async ({ request }) => {
    // The 00:37 case needs a fake clock and is a unit test; this pins that
    // "today" from the client's calendar is never read as tomorrow.
    const { headers, leg, item } = await departedCycle(request);
    expect((await deliver(request, headers, leg.id, item, 1, today())).status).toBeLessThan(300);
  });
});

test.describe('Losses', () => {
  test('TC-DL-20: Loss of more than is on the way → LOSS_EXCEEDS_IN_TRANSIT', async ({ request }) => {
    const { headers, legs, item } = await departedCycle(request, 'CHINA');
    await deliver(request, headers, legs[0].id, item, 30, daysAgo(12));
    const r = await lose(request, headers, legs[0].id, item, 11);
    expect(r.code).toBe('LOSS_EXCEEDS_IN_TRANSIT');
    expect(r.params).toEqual(expect.objectContaining({ onTheWay: 10, asked: 11 }));
  });

  test('TC-DL-21: Loss of 5 → a loss record at 5 × unit cost; no ledger row; cash unchanged', async ({ request }) => {
    const { headers, cycle, leg, item } = await departedCycle(request);
    const ledgerBefore = (await (await request.get(`${API}/ledger?cycleId=${cycle.id}`, { headers })).json()).data;
    const r = await lose(request, headers, leg.id, item, 5);
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    // 40 at 100 + 400 freight = 4,400 over 40 → 110.00 a unit.
    expect(Number(r.body.data[0].costEgp)).toBe(550);
    const ledgerAfter = (await (await request.get(`${API}/ledger?cycleId=${cycle.id}`, { headers })).json()).data;
    expect(ledgerAfter).toHaveLength(ledgerBefore.length);
    const s = await shipment(request, headers, cycle.id);
    expect(s.legs[0].onTheWay).toBe(35);
    expect(s.lines[0].lost).toBe(5);
  });

  test('TC-DL-22: Loss then a delivery: on the way shrinks by both, and a delivery for the lost units is refused', async ({ request }) => {
    const { headers, cycle, leg, item } = await departedCycle(request);
    await lose(request, headers, leg.id, item, 10);
    await deliver(request, headers, leg.id, item, 25);
    expect((await shipment(request, headers, cycle.id)).legs[0].onTheWay).toBe(5);
    expect((await deliver(request, headers, leg.id, item, 6)).code).toBe('DELIVERY_EXCEEDS_IN_TRANSIT');
  });

  test('TC-DL-23: Take a loss back → the units are on the way again', async ({ request }) => {
    const { headers, cycle, leg, item } = await departedCycle(request);
    const made = await lose(request, headers, leg.id, item, 10);
    const id = made.body.data[0].id;
    const res = await request.delete(`${API}/shipping/losses/${id}`, { headers });
    expect(res.ok(), await res.text()).toBeTruthy();
    expect((await shipment(request, headers, cycle.id)).legs[0].onTheWay).toBe(40);
    // The second time: it is gone.
    const again = await request.delete(`${API}/shipping/losses/${id}`, { headers });
    expect(again.status()).toBe(404);
  });
});

test.describe('Deleting a delivery', () => {
  test('TC-DL-30: Deleting a leg-1 delivery that leg 2 has drawn on → DELIVERY_IN_USE', async ({ request }) => {
    const { headers, legs, item } = await departedCycle(request, 'CHINA');
    const first = await deliver(request, headers, legs[0].id, item, 20, daysAgo(15));
    await deliver(request, headers, legs[0].id, item, 20, daysAgo(12));
    await deliver(request, headers, legs[1].id, item, 30, daysAgo(5));
    const res = await request.delete(`${API}/shipping/deliveries/${first.body.data.id}`, { headers });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toEqual(expect.objectContaining({ code: 'DELIVERY_IN_USE' }));
  });

  test('TC-DL-31: Deleting the only last-leg delivery of a cycle in ARRIVED_EGYPT → DELIVERY_IN_USE', async ({ request }) => {
    const { headers, mk, cycle, leg, item } = await departedCycle(request);
    const d = await deliver(request, headers, leg.id, item, 10);
    for (const status of ['FUNDING', 'PURCHASING', 'ARRIVED_UAE', 'IN_TRANSIT_TO_EGYPT', 'ARRIVED_EGYPT']) {
      await mk(`cycles/${cycle.id}/transition`, { status });
    }
    const res = await request.delete(`${API}/shipping/deliveries/${d.body.data.id}`, { headers });
    expect((await res.json()).error.code).toBe('DELIVERY_IN_USE');
  });

  test('TC-DL-32: Delete a delivery that was not received → removed, and the leg status is re-derived', async ({ request }) => {
    const { headers, cycle, leg, item } = await departedCycle(request);
    await deliver(request, headers, leg.id, item, 30, daysAgo(8));
    const second = await deliver(request, headers, leg.id, item, 10, daysAgo(4));
    expect((await shipment(request, headers, cycle.id)).legs[0].status).toBe('ARRIVED');
    const res = await request.delete(`${API}/shipping/deliveries/${second.body.data.id}`, { headers });
    expect(res.ok(), await res.text()).toBeTruthy();
    const legsNow = (await (await request.get(`${API}/cycles/${cycle.id}/shipping-legs`, { headers })).json()).data;
    expect(legsNow[0].status).toBe('PARTLY_ARRIVED');
    expect(legsNow[0].arrivedOn).toBeNull();
  });
});

test.describe('The old leg form and the cycle gates', () => {
  test('TC-DL-40: PUT leg with arrivedOn and 25 still on the way → one delivery of 25; again with the same date → no new delivery', async ({ request }) => {
    const { headers, cycle, leg, item } = await departedCycle(request);
    await deliver(request, headers, leg.id, item, 15, daysAgo(10));
    for (let i = 0; i < 2; i++) {
      const res = await request.put(`${API}/shipping/legs/${leg.id}`, { headers, data: { arrivedOn: daysAgo(4) } });
      expect(res.ok(), await res.text()).toBeTruthy();
    }
    const s = await shipment(request, headers, cycle.id);
    expect(s.legs[0].deliveries.map((d: { lines: { qty: number }[] }) => d.lines[0].qty)).toEqual([15, 25]);
  });

  test('TC-DL-41: PUT leg with a future arrivedOn → refused; with arrivedOn: null or a status → ignored', async ({ request }) => {
    const { headers, cycle, leg, item } = await departedCycle(request);
    await deliver(request, headers, leg.id, item, 15);
    const future = await request.put(`${API}/shipping/legs/${leg.id}`, { headers, data: { arrivedOn: tomorrow() } });
    expect((await future.json()).error.code).toBe('DATE_IN_FUTURE');
    const ignored = await request.put(`${API}/shipping/legs/${leg.id}`, {
      headers, data: { arrivedOn: null, status: 'ARRIVED' },
    });
    expect(ignored.ok(), await ignored.text()).toBeTruthy();
    expect((await ignored.json()).data.status).toBe('PARTLY_ARRIVED');
    expect((await shipment(request, headers, cycle.id)).legs[0].delivered).toBe(15);
  });

  test("TC-DL-42: Moving a leg's departure after a delivery so the delivery predates it → refused", async ({ request }) => {
    const { headers, leg, item } = await departedCycle(request);
    await deliver(request, headers, leg.id, item, 15, daysAgo(10));
    const res = await request.put(`${API}/shipping/legs/${leg.id}`, { headers, data: { departedOn: daysAgo(9) } });
    expect((await res.json()).error.code).toBe('DELIVERY_BEFORE_DEPARTURE');
  });

  test("TC-DL-43: Changing a leg's cost after a loss → LEG_COST_LOCKED", async ({ request }) => {
    const { headers, leg, item } = await departedCycle(request);
    await lose(request, headers, leg.id, item, 1);
    const res = await request.put(`${API}/shipping/legs/${leg.id}`, { headers, data: { amount: 500 } });
    expect((await res.json()).error.code).toBe('LEG_COST_LOCKED');
  });

  test('TC-DL-LATE-FREIGHT: A late freight charge after the cost lock → an ordinary ledger expense on the cycle, counted once; no batch cost changes', async ({ request }) => {
    const { headers, mk, cycle, leg, item, product } = await departedCycle(request);
    await deliver(request, headers, leg.id, item, 40);
    for (const status of ['FUNDING', 'PURCHASING', 'ARRIVED_UAE', 'IN_TRANSIT_TO_EGYPT', 'ARRIVED_EGYPT', 'VERIFICATION']) {
      await mk(`cycles/${cycle.id}/transition`, { status });
    }
    await mk('receipts/verify', {
      cycleId: cycle.id,
      items: [{ purchaseOrderItemId: item.id, productId: product.id, receivedQty: 40 }],
    });
    const batchCost = async () => {
      const body = await (await request.get(`${API}/inventory`, { headers })).json();
      const row = (body.data ?? []).find((i: { productId: string }) => i.productId === product.id);
      return (row?.batches ?? []).map((b: { landedUnitCostEgp: string | number }) => b.landedUnitCostEgp);
    };
    const costBefore = await batchCost();

    const locked = await request.put(`${API}/shipping/legs/${leg.id}`, { headers, data: { amount: 650 } });
    expect((await locked.json()).error.code).toBe('LEG_COST_LOCKED');

    const preview = async () =>
      (await (await request.get(`${API}/settlements/preview/${cycle.id}`, { headers })).json()).data;
    const before = await preview();
    await mk('ledger', {
      type: 'EXPENSE', category: 'other', direction: 'OUTFLOW', amount: 250,
      currency: 'EGP', cycleId: cycle.id, reason: 'Late freight surcharge on leg 1',
    });
    const after = await preview();
    if (before && after) {
      // Counted once: the expense moves by exactly the charge.
      expect(Number(after.expensesEgp) - Number(before.expensesEgp)).toBeCloseTo(250, 2);
    }
    expect(await batchCost()).toEqual(costBefore);
  });

  test('TC-DL-50: Cycle → ARRIVED_UAE after leg 1\'s first delivery of 15/40 → allowed; with no delivery → LEG_NOT_ARRIVED', async ({ request }) => {
    const { headers, mk, cycle, legs, item } = await departedCycle(request, 'CHINA');
    for (const status of ['FUNDING', 'PURCHASING', 'IN_TRANSIT']) {
      await mk(`cycles/${cycle.id}/transition`, { status });
    }
    const early = await post(request, headers, `cycles/${cycle.id}/transition`, { status: 'ARRIVED_UAE' });
    expect(early.code).toBe('LEG_NOT_ARRIVED');
    await deliver(request, headers, legs[0].id, item, 15, daysAgo(15));
    const ok = await post(request, headers, `cycles/${cycle.id}/transition`, { status: 'ARRIVED_UAE' });
    expect(ok.status, JSON.stringify(ok.body)).toBeLessThan(300);
  });

  test('TC-DL-51: Cycle → ARRIVED_EGYPT with the last leg partly arrived → allowed', async ({ request }) => {
    const { headers, mk, cycle, legs, item } = await departedCycle(request, 'CHINA');
    await deliver(request, headers, legs[0].id, item, 30, daysAgo(15));
    for (const status of ['FUNDING', 'PURCHASING', 'IN_TRANSIT', 'ARRIVED_UAE', 'IN_TRANSIT_TO_EGYPT']) {
      await mk(`cycles/${cycle.id}/transition`, { status });
    }
    await deliver(request, headers, legs[1].id, item, 12, daysAgo(5));
    const ok = await post(request, headers, `cycles/${cycle.id}/transition`, { status: 'ARRIVED_EGYPT' });
    expect(ok.status, JSON.stringify(ok.body)).toBeLessThan(300);
  });
});

test.describe('Roles', () => {
  test('TC-DL-60: Investor or shop token on each endpoint, including DELETE /shipping/losses/:id → refused with a code', async ({ request }) => {
    const { headers, leg, item } = await departedCycle(request);
    const d = await deliver(request, headers, leg.id, item, 5);
    const l = await lose(request, headers, leg.id, item, 5);
    // A shop owner's real token is a portal one: registration offers office roles
    // only, so it is refused by the surface fence (WRONG_SURFACE), not the role guard.
    for (const { who, headers: h, code } of await refusedCallers(request, 'deliveries')) {
      const calls = [
        request.post(`${API}/shipping/legs/${leg.id}/deliveries`, { headers: h, data: { arrivedOn: daysAgo(3), lines: lines(item, 1) } }),
        request.post(`${API}/shipping/legs/${leg.id}/losses`, { headers: h, data: { lines: lines(item, 1) } }),
        request.delete(`${API}/shipping/deliveries/${d.body.data.id}`, { headers: h }),
        request.delete(`${API}/shipping/losses/${l.body.data[0].id}`, { headers: h }),
      ];
      for (const res of await Promise.all(calls)) {
        expect(res.status(), `${who}: ${res.url()}`).toBe(403);
        expect((await res.json()).error.code, `${who}: ${res.url()}`).toBe(code);
      }
    }
  });
});
