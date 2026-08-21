/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: Supplier refunds
 * ═══════════════════════════════════════════════════════════════════════
 *  A refund was recorded but had no financial effect: no ledger entry, and
 *  the cycle's cost never dropped, so its profit stayed understated.
 */
import { test, expect } from '@playwright/test';

const API = 'http://localhost:3001/api/v1';
const EMAIL = 'partner.a@motoparts.com';
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
async function purchaseOrderWithReportedCycle(request: any, h: any) {
  const cycles = (await (await request.get(`${API}/analytics/cycle-profitability`, { headers: h })).json()).data;
  const codes = new Set(cycles.map((c: any) => c.cycleCode));
  const list = (await (await request.get(`${API}/purchases?limit=50`, { headers: h })).json()).data ?? [];
  return list.find((po: any) => codes.has(po.cycle?.code));
}

function cycle(cycles: any[], code: string) {
  return cycles.find((c: any) => c.cycleCode === code);
}

test.describe('Supplier refunds', () => {
  test('TC-SUP-01: a refund reaches the ledger in EGP', async ({ request }) => {
    const h = await auth(request);
    const po = await anyPurchaseOrder(request, h);
    test.skip(!po, 'no purchase orders');

    const res = await request.post(`${API}/purchases/${po.id}/refunds`, {
      headers: h,
      data: { amount: 10, currency: 'USD', fxRateToEgp: 48.5, reason: 'damaged in transit' },
    });
    expect(res.ok()).toBeTruthy();
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
    const po = await purchaseOrderWithReportedCycle(request, h);
    test.skip(!po, 'no purchase order on a reported cycle');

    const cyclesBefore = (await (await request.get(`${API}/analytics/cycle-profitability`, { headers: h })).json()).data;
    const before = cyclesBefore.find((c: any) => c.cycleCode === po.cycle?.code);

    const amount = 5;
    const fx = 48.5;
    await request.post(`${API}/purchases/${po.id}/refunds`, {
      headers: h,
      data: { amount, currency: 'USD', fxRateToEgp: fx, reason: 'short shipment' },
    });

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
