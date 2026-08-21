/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: Customer returns
 * ═══════════════════════════════════════════════════════════════════════
 *  Goods come back to the batch they were sold from, at the cost they left
 *  at, and every profit figure downstream corrects itself — without the
 *  original sale being edited (BRD 9, 10).
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

/** A confirmed order with an allocated line we can send back. */
async function returnableOrder(request: any, h: any) {
  const list = (await (await request.get(`${API}/sales/orders?limit=50`, { headers: h })).json()).data;
  for (const o of list) {
    if (!['CONFIRMED', 'PARTIALLY_PAID', 'PAID'].includes(o.status)) continue;
    const full = (await (await request.get(`${API}/sales/orders/${o.id}`, { headers: h })).json()).data;
    const line = (full.items ?? []).find((i: any) => (i.allocations ?? []).length > 0);
    if (line) return { order: full, line };
  }
  return null;
}

test.describe('Customer returns', () => {
  test('TC-RET-01: stock goes back to the batch it was sold from', async ({ request }) => {
    const h = await auth(request);
    const found = await returnableOrder(request, h);
    test.skip(!found, 'no confirmed order with allocations');
    const { order, line } = found!;

    const batchId = line.allocations[0].inventoryBatchId;
    const before = (await (await request.get(`${API}/inventory?limit=100`, { headers: h })).json()).data;
    const batchBefore = before
      .flatMap((p: any) => p.batches ?? [])
      .find((b: any) => b.id === batchId);

    const res = await request.post(`${API}/returns`, {
      headers: h,
      data: {
        saleOrderId: order.id,
        reason: 'wrong fitment',
        items: [{ saleItemId: line.id, qty: 1 }],
      },
    });
    expect(res.ok()).toBeTruthy();
    const ret = (await res.json()).data;

    // The batch matters: the same product sits in several batches at
    // different landed costs, so restocking "the product" would re-price it.
    expect(ret.items[0].inventoryBatchId).toBe(batchId);
    expect(Number(ret.items[0].unitCostEgp)).toBeCloseTo(
      Number(line.allocations[0].unitCostEgp), 4,
    );

    if (batchBefore) {
      const after = (await (await request.get(`${API}/inventory?limit=100`, { headers: h })).json()).data;
      const batchAfter = after.flatMap((p: any) => p.batches ?? []).find((b: any) => b.id === batchId);
      expect(Number(batchAfter.remainingQty)).toBeCloseTo(Number(batchBefore.remainingQty) + 1, 3);
    }
  });

  test('TC-RET-02: the original sale is never edited', async ({ request }) => {
    const h = await auth(request);
    const found = await returnableOrder(request, h);
    test.skip(!found, 'no confirmed order with allocations');
    const { order, line } = found!;

    const totalBefore = Number(order.total);

    await request.post(`${API}/returns`, {
      headers: h,
      data: { saleOrderId: order.id, reason: 'changed mind', items: [{ saleItemId: line.id, qty: 1 }] },
    });

    const after = (await (await request.get(`${API}/sales/orders/${order.id}`, { headers: h })).json()).data;
    // What was sold is a historical fact; only what is owed changes.
    expect(Number(after.total)).toBeCloseTo(totalBefore, 2);
  });

  test('TC-RET-03: a credit note reduces what the customer owes', async ({ request }) => {
    const h = await auth(request);
    const found = await returnableOrder(request, h);
    test.skip(!found, 'no confirmed order with allocations');
    const { order, line } = found!;
    test.skip(Number(order.outstanding) <= 0, 'order already settled');

    const outstandingBefore = Number(order.outstanding);
    const res = await request.post(`${API}/returns`, {
      headers: h,
      data: { saleOrderId: order.id, reason: 'credit please', items: [{ saleItemId: line.id, qty: 1 }] },
    });
    const refund = Number((await res.json()).data.refundEgp);

    const after = (await (await request.get(`${API}/sales/orders/${order.id}`, { headers: h })).json()).data;
    expect(Number(after.outstanding)).toBeCloseTo(Math.max(outstandingBefore - refund, 0), 2);
  });

  test('TC-RET-04: damaged goods are refunded but not restocked', async ({ request }) => {
    const h = await auth(request);
    const found = await returnableOrder(request, h);
    test.skip(!found, 'no confirmed order with allocations');
    const { order, line } = found!;

    const res = await request.post(`${API}/returns`, {
      headers: h,
      data: {
        saleOrderId: order.id,
        reason: 'arrived cracked',
        items: [{ saleItemId: line.id, qty: 1, restock: false }],
      },
    });
    const ret = (await res.json()).data;

    expect(Number(ret.refundEgp)).toBeGreaterThan(0);
    // The cost stays spent: the goods never went back on the shelf.
    expect(Number(ret.cogsReversedEgp)).toBe(0);
    expect(ret.items[0].restocked).toBe(false);
  });

  test('TC-RET-05: you cannot return more than was sold', async ({ request }) => {
    const h = await auth(request);
    const found = await returnableOrder(request, h);
    test.skip(!found, 'no confirmed order with allocations');
    const { order, line } = found!;

    const res = await request.post(`${API}/returns`, {
      headers: h,
      data: {
        saleOrderId: order.id,
        reason: 'more than exists',
        items: [{ saleItemId: line.id, qty: Number(line.quantity) + 1000 }],
      },
    });
    expect(res.status()).toBe(400);
    expect(JSON.stringify(await res.json())).toMatch(/still returnable|cannot return/i);
  });

  test('TC-RET-06: a return needs a reason and a positive quantity', async ({ request }) => {
    const h = await auth(request);
    const found = await returnableOrder(request, h);
    test.skip(!found, 'no confirmed order with allocations');
    const { order, line } = found!;

    const noReason = await request.post(`${API}/returns`, {
      headers: h,
      data: { saleOrderId: order.id, reason: '', items: [{ saleItemId: line.id, qty: 1 }] },
    });
    expect(noReason.status()).toBe(400);

    const noQty = await request.post(`${API}/returns`, {
      headers: h,
      data: { saleOrderId: order.id, reason: 'valid reason', items: [{ saleItemId: line.id, qty: 0 }] },
    });
    expect(noQty.status()).toBe(400);
  });

  test('TC-RET-07: a return corrects the cycle profit it came from', async ({ request }) => {
    const h = await auth(request);
    const found = await returnableOrder(request, h);
    test.skip(!found, 'no confirmed order with allocations');
    const { order, line } = found!;

    const cyclesBefore = (await (await request.get(`${API}/analytics/cycle-profitability`, { headers: h })).json()).data;
    const totalRevBefore = cyclesBefore.reduce((s: number, c: any) => s + Number(c.totalRevenue), 0);
    const totalCogsBefore = cyclesBefore.reduce((s: number, c: any) => s + Number(c.totalCost), 0);

    const res = await request.post(`${API}/returns`, {
      headers: h,
      data: { saleOrderId: order.id, reason: 'profit check', items: [{ saleItemId: line.id, qty: 1 }] },
    });
    const ret = (await res.json()).data;

    const cyclesAfter = (await (await request.get(`${API}/analytics/cycle-profitability`, { headers: h })).json()).data;
    const totalRevAfter = cyclesAfter.reduce((s: number, c: any) => s + Number(c.totalRevenue), 0);
    const totalCogsAfter = cyclesAfter.reduce((s: number, c: any) => s + Number(c.totalCost), 0);

    // Returning goods un-earns the revenue and un-spends the cost. Without
    // this the cycle keeps reporting profit on goods it no longer sold.
    expect(totalRevAfter).toBeCloseTo(totalRevBefore - Number(ret.refundEgp), 2);
    expect(totalCogsAfter).toBeCloseTo(totalCogsBefore - Number(ret.cogsReversedEgp), 2);
  });
});
