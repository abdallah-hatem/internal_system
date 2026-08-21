/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: Stock quantity invariants
 * ═══════════════════════════════════════════════════════════════════════
 *  Confirming a sale used to move saleable to reserved without reducing
 *  remaining, and nothing released the reservation — so remaining counted
 *  goods that had left, inflating inventory value and the unsold figure a
 *  cycle is closed on, and a return could push a batch above what arrived.
 */
import { test, expect } from '@playwright/test';

const API = 'http://localhost:3001/api/v1';

async function auth(request: any) {
  const res = await request.post(`${API}/auth/login`, {
    data: { email: 'partner.a@motoparts.com', password: 'password123' },
  });
  return { Authorization: `Bearer ${(await res.json()).data.accessToken}` };
}

const batches = async (request: any, h: any) => {
  const inv = (await (await request.get(`${API}/inventory?limit=100`, { headers: h })).json()).data ?? [];
  return inv.flatMap((p: any) => (p.batches ?? []).map((b: any) => ({ ...b, productId: p.productId })));
};

async function sellable(request: any, h: any) {
  const all = await batches(request, h);
  return all.find((b: any) => b.verificationStatus === 'VERIFIED' && Number(b.saleableQty) > 0);
}

test.describe('Stock quantities', () => {
  test('TC-STK-01: a batch never holds more than arrived', async ({ request }) => {
    const h = await auth(request);
    for (const b of await batches(request, h)) {
      // Goods can only come back from a sale, so remaining can never exceed
      // what was received plus what was returned into it.
      expect(
        Number(b.remainingQty),
        `batch ${b.id} holds ${b.remainingQty} of ${b.receivedQty} received`,
      ).toBeLessThanOrEqual(Number(b.receivedQty));
    }
  });

  test('TC-STK-02: remaining is fully accounted for as saleable or reserved', async ({ request }) => {
    const h = await auth(request);
    for (const b of await batches(request, h)) {
      expect(
        Number(b.saleableQty) + Number(b.reservedQty),
        `batch ${b.id} does not add up`,
      ).toBeCloseTo(Number(b.remainingQty), 3);
    }
  });

  test('TC-STK-03: no quantity is negative', async ({ request }) => {
    const h = await auth(request);
    for (const b of await batches(request, h)) {
      expect(Number(b.remainingQty)).toBeGreaterThanOrEqual(0);
      expect(Number(b.saleableQty)).toBeGreaterThanOrEqual(0);
      expect(Number(b.reservedQty)).toBeGreaterThanOrEqual(0);
    }
  });

  test('TC-STK-04: confirming a sale reduces the stock physically present', async ({ request }) => {
    const h = await auth(request);
    const batch = await sellable(request, h);
    test.skip(!batch, 'no saleable verified stock');

    const before = Number(batch.remainingQty);
    const qty = Math.min(2, Number(batch.saleableQty));

    const order = (await (await request.post(`${API}/sales/orders`, {
      headers: h,
      data: {
        customerId: '00000000-0000-4000-8000-000000000050',
        channel: 'B2B', currency: 'EGP',
        items: [{ productId: batch.productId, quantity: qty, unitPrice: 200 }],
      },
    })).json()).data;

    const confirm = await request.post(`${API}/sales/orders/${order.id}/confirm`, {
      headers: h, data: { version: order.version },
    });
    expect(confirm.ok()).toBeTruthy();

    const after = (await batches(request, h)).find((b: any) => b.id === batch.id);
    // The goods have gone to the customer; the room holds fewer.
    expect(Number(after.remainingQty)).toBeCloseTo(before - qty, 3);
  });

  test('TC-STK-05: cancelling a confirmed sale puts the stock back', async ({ request }) => {
    const h = await auth(request);
    const batch = await sellable(request, h);
    test.skip(!batch, 'no saleable verified stock');

    const before = Number(batch.remainingQty);
    const qty = Math.min(2, Number(batch.saleableQty));

    const order = (await (await request.post(`${API}/sales/orders`, {
      headers: h,
      data: {
        customerId: '00000000-0000-4000-8000-000000000050',
        channel: 'B2B', currency: 'EGP',
        items: [{ productId: batch.productId, quantity: qty, unitPrice: 200 }],
      },
    })).json()).data;
    await request.post(`${API}/sales/orders/${order.id}/confirm`, {
      headers: h, data: { version: order.version },
    });
    await request.post(`${API}/sales/orders/${order.id}/cancel`, { headers: h });

    const after = (await batches(request, h)).find((b: any) => b.id === batch.id);
    expect(Number(after.remainingQty)).toBeCloseTo(before, 3);
  });

  test('TC-STK-06: inventory value counts only stock actually held', async ({ request }) => {
    const h = await auth(request);
    const dash = (await (await request.get(`${API}/analytics/dashboard`, { headers: h })).json()).data;

    const expected = (await batches(request, h)).reduce(
      (s: number, b: any) => s + Number(b.remainingQty) * Number(b.landedUnitCostEgp),
      0,
    );
    // Counting goods that had already left inflated this figure by everything
    // ever sold.
    expect(Number(dash.inventoryValue)).toBeCloseTo(expected, 2);
  });
});
