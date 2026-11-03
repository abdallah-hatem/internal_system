/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: Supplier refunds
 * ═══════════════════════════════════════════════════════════════════════
 *  A refund was recorded but had no financial effect: no ledger entry, and
 *  the cycle's cost never dropped, so its profit stayed understated.
 */
import { test, expect } from '@playwright/test';
import { API } from './support/env';
import { allPages } from './support/fixtures';

const EMAIL = 'abdallah@motoparts.com';
const PASSWORD = 'password123';

async function auth(request: any) {
  const res = await request.post(`${API}/auth/login`, {
    data: { email: EMAIL, password: PASSWORD },
  });
  return { Authorization: `Bearer ${(await res.json()).data.accessToken}` };
}

async function anyPurchaseOrder(request: any, h: any) {
  const list = (await (await request.get(`${API}/purchases?limit=50`, { headers: h })).json()).data;
  return list?.[0];
}

/**
 * A purchase order whose cycle actually appears in the comparison — a cycle
 * still in planning has no batches and is not reported, so asserting against
 * it would silently skip.
 */
/** A purchase order as the list sends it, the fields read here. */
type ListedOrder = { id: string; cycle?: { code: string }; fxRateToEgp: string; items?: { lineTotal: string }[] };

async function purchaseOrderWithReportedCycle(request: any, h: any, refundEgp: number): Promise<ListedOrder | undefined> {
  const cycles = (await (await request.get(`${API}/analytics/cycle-profitability`, { headers: h })).json()).data;
  const codes = new Set(cycles.map((c: any) => c.cycleCode));
  // Every order, not the newest fifty, and one big enough to give the refund
  // back: a supplier cannot refund more than the order was worth (§6,
  // REFUND_EXCEEDS_ORDER). The newest order on a reported cycle was a 30 EGP
  // one some earlier spec made, refused the 242.50 below, and the test then
  // compared figures nothing had changed (CI, 2026-11-02). Room for this
  // refund several times over, so TC-SUP-01's refunds and a retry still fit.
  const list = (await allPages(request, h, 'purchases')) as unknown as ListedOrder[];
  const valueEgp = (po: ListedOrder) =>
    (po.items ?? []).reduce((s, i) => s + Number(i.lineTotal), 0) * Number(po.fxRateToEgp);
  return list.find((po) => codes.has(po.cycle?.code) && valueEgp(po) >= 10 * refundEgp);
}

function cycle(cycles: any[], code: string) {
  return cycles.find((c: any) => c.cycleCode === code);
}

test.describe('Supplier refunds', () => {
  test('TC-SUP-01: a refund reaches the ledger in EGP', async ({ request }) => {
    const h = await auth(request);
    // An order that can give 485 back — the newest one may be smaller (below).
    const found = await purchaseOrderWithReportedCycle(request, h, 10 * 48.5);
    test.skip(!found, 'no purchase orders');
    const po = found!;

    const res = await request.post(`${API}/purchases/${po.id}/refunds`, {
      headers: h,
      data: { amount: 10, currency: 'USD', fxRateToEgp: 48.5, reason: 'damaged in transit' },
    });
    expect(res.ok(), await res.text()).toBeTruthy();
    const refund = (await res.json()).data;

    const ledger = (await (await request.get(`${API}/ledger?limit=200`, { headers: h })).json()).data ?? [];
    const entry = ledger.find(
      (e: any) => e.type === 'SUPPLIER_REFUND' && e.relatedId === refund.id,
    );
    expect(entry).toBeTruthy();
    // Recorded in the cycle's currency, converted at the stated rate.
    expect(Number(entry.amount)).toBeCloseTo(10 * 48.5, 2);
    expect(entry.direction).toBe('INFLOW');
  });

  test('TC-SUP-02: a refund reduces what the cycle cost and lifts its profit', async ({ request }) => {
    const h = await auth(request);
    const amount = 5;
    const fx = 48.5;
    const found = await purchaseOrderWithReportedCycle(request, h, amount * fx);
    test.skip(!found, 'no purchase order on a reported cycle');
    const po = found!;

    const cyclesBefore = (await (await request.get(`${API}/analytics/cycle-profitability`, { headers: h })).json()).data;
    const before = cyclesBefore.find((c: any) => c.cycleCode === po.cycle?.code);

    const refunded = await request.post(`${API}/purchases/${po.id}/refunds`, {
      headers: h,
      data: { amount, currency: 'USD', fxRateToEgp: fx, reason: 'short shipment' },
    });
    expect(refunded.ok(), `refund: ${await refunded.text()}`).toBeTruthy();

    const cyclesAfter = (await (await request.get(`${API}/analytics/cycle-profitability`, { headers: h })).json()).data;
    const after = cyclesAfter.find((c: any) => c.cycleCode === po.cycle?.code);

    const egp = amount * fx;
    // Money back is cost recovered: less invested, more profit. It must not
    // re-price batches, because units already sold keep the cost they were
    // sold at and a settlement may already be agreed on it.
    expect(Number(after.investment)).toBeCloseTo(Number(before.investment) - egp, 2);
    expect(Number(after.profit)).toBeCloseTo(Number(before.profit) + egp, 2);
    expect(Number(after.totalCost)).toBeCloseTo(Number(before.totalCost), 2);
  });

  test('TC-SUP-03: a refund larger than the order is refused', async ({ request }) => {
    const h = await auth(request);
    const po = await anyPurchaseOrder(request, h);
    test.skip(!po, 'no purchase orders');

    const res = await request.post(`${API}/purchases/${po.id}/refunds`, {
      headers: h,
      data: { amount: 99999999, currency: 'USD', fxRateToEgp: 48.5, reason: 'too much' },
    });
    expect(res.status()).toBe(400);
    expect(JSON.stringify(await res.json())).toMatch(/exceeds/i);
  });

  test('TC-SUP-04: amount and fx rate must be positive', async ({ request }) => {
    const h = await auth(request);
    const po = await anyPurchaseOrder(request, h);
    test.skip(!po, 'no purchase orders');

    for (const data of [
      { amount: -5, currency: 'USD', fxRateToEgp: 48.5 },
      { amount: 0, currency: 'USD', fxRateToEgp: 48.5 },
      { amount: 5, currency: 'USD', fxRateToEgp: 0 },
    ]) {
      const res = await request.post(`${API}/purchases/${po.id}/refunds`, { headers: h, data });
      expect(res.status()).toBe(400);
    }
  });

  test('TC-SUP-05: batch costs are untouched by a refund', async ({ request }) => {
    const h = await auth(request);
    const po = await anyPurchaseOrder(request, h);
    test.skip(!po, 'no purchase orders');

    const costsOf = async () => {
      const inv = (await (await request.get(`${API}/inventory?limit=100`, { headers: h })).json()).data ?? [];
      return inv
        .flatMap((p: any) => p.batches ?? [])
        .map((b: any) => `${b.id}:${b.landedUnitCostEgp}`)
        .sort()
        .join('|');
    };

    const before = await costsOf();
    await request.post(`${API}/purchases/${po.id}/refunds`, {
      headers: h,
      data: { amount: 1, currency: 'USD', fxRateToEgp: 48.5, reason: 'cost check' },
    });
    // Re-pricing batches would change the COGS of sales already made.
    expect(await costsOf()).toBe(before);
  });
});
