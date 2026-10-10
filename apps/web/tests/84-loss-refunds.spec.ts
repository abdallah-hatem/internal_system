/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: Refunds for goods lost on the way (plan B5)
 * ═══════════════════════════════════════════════════════════════════════
 *  Whoever lost the goods — the leg's shipping company or the order's
 *  supplier — may pay some or all of it back (BUSINESS_LOGIC §6, 2026-10-10).
 *  A refund is recorded against the loss, in any currency, as a ledger inflow
 *  that recovers cost. Refunds on one loss never pass its cost; a refunded
 *  loss cannot be taken back.
 *
 *  Every case here is also a unit test in
 *  apps/api/src/modules/purchases/loss-refunds.spec.ts, under the same name;
 *  this suite is the same rules through the real API and database. The race
 *  is also run against real Postgres in loss-refunds.db.spec.ts.
 *
 *  Not covered here, and why:
 *  - A refund on a CLOSED cycle: closing needs a whole selling and settlement
 *    flow; the unit suite covers it with the cycle where that flow leaves it.
 *  - The "Record refund" dialog on the cycle page is F1a's (built in
 *    parallel); its interaction cases belong in F1a's spec.
 */
import { test, expect, APIRequestContext } from '@playwright/test';
import { apiCtx, API, daysAgo, today } from './support/fixtures';

type Headers = Record<string, string>;

async function accountWithRole(request: APIRequestContext, role: string) {
  const { headers } = await apiCtx(request);
  const stamp = `${Date.now()}${Math.floor(performance.now() % 1000)}`;
  const email = `loss-refunds-${role.toLowerCase()}-${stamp}@motoparts.com`;
  const made = await request.post(`${API}/auth/register`, {
    headers,
    data: { email, password: 'password123', displayName: `Loss refunds ${stamp}`, role },
  });
  expect(made.ok(), `create ${role}: ${await made.text()}`).toBeTruthy();
  const signedIn = await request.post(`${API}/auth/login`, {
    data: { email, password: 'password123' },
  });
  return { Authorization: `Bearer ${(await signedIn.json()).data.accessToken}` };
}

/**
 * A UAE-direct cycle: `ordered` of one product at 100 and a 400 leg run by a
 * shipping company, departed 20 days ago, `lost` of them marked lost on the
 * way. 40 ordered → 110 a unit, so 5 lost cost 550.
 */
async function cycleWithALoss(
  request: APIRequestContext,
  opts: { ordered?: number; lost?: number } = {},
) {
  const { headers, mk } = await apiCtx(request);
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const product = await mk('products', { name: `LRef ${stamp} Part`, minStock: 0 });
  const supplier = await mk('suppliers', { name: `LRef ${stamp} Supplier`, country: 'AE' });
  const provider = await mk('providers', { name: `LRef ${stamp} Freight` });
  const cycle = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'EGP' });
  const po = await mk(`cycles/${cycle.id}/purchases`, {
    supplierId: supplier.id, currency: 'EGP', fxRateToEgp: 1, orderedOn: daysAgo(25),
    items: [{ productId: product.id, orderedQty: opts.ordered ?? 40, unitPrice: 100 }],
  });
  const leg = await mk(`cycles/${cycle.id}/shipping-legs`, {
    sequence: 1, origin: 'Dubai, UAE', destination: 'Cairo, Egypt', providerId: provider.id,
    costBasis: 'FLAT', amount: 400, currency: 'EGP', fxRateToEgp: 1, departedOn: daysAgo(20),
  });
  const full = await (await request.get(`${API}/cycles/${cycle.id}`, { headers })).json();
  const item = (full.data ?? full).purchaseOrders[0].items[0];
  const [loss] = await mk(`shipping/legs/${leg.id}/losses`, {
    lines: [{ purchaseOrderItemId: item.id, qty: opts.lost ?? 5 }],
  });
  return { headers, mk, cycle, po, leg, item, loss, product, supplier, provider };
}

async function post(request: APIRequestContext, headers: Headers, path: string, data: unknown) {
  const res = await request.post(`${API}/${path}`, { headers, data });
  const body = await res.json().catch(() => ({}));
  return { status: res.status(), body, code: body?.error?.code, params: body?.error?.params };
}

const fromProvider = (p: { id: string }) => ({ type: 'SHIPPING_PROVIDER', id: p.id });
const fromSupplier = (s: { id: string }) => ({ type: 'SUPPLIER', id: s.id });

const refund = (
  request: APIRequestContext,
  headers: Headers,
  lossId: string,
  payer: { type: string; id: string },
  amount: number,
  extra: Record<string, unknown> = {},
) =>
  post(request, headers, `shipping/losses/${lossId}/refunds`, {
    amount, currency: 'EGP', fxRateToEgp: 1, recordedOn: today(), payer, ...extra,
  });

async function lossRead(request: APIRequestContext, headers: Headers, cycleId: string, lossId: string) {
  const s = (await (await request.get(`${API}/cycles/${cycleId}/shipment`, { headers })).json()).data;
  return s.losses.find((x: { id: string }) => x.id === lossId);
}

const tomorrow = () => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
};

test.describe('POST /shipping/losses/:id/refunds — the cap', () => {
  test('TC-LR-01: A loss of 550 refunded 300 then 250 → both accepted; then 1 more → REFUND_EXCEEDS_LOSS', async ({ request }) => {
    const { headers, cycle, loss, provider, supplier } = await cycleWithALoss(request);
    expect(Number(loss.costEgp)).toBe(550);
    expect((await refund(request, headers, loss.id, fromProvider(provider), 300)).status).toBeLessThan(300);
    expect((await refund(request, headers, loss.id, fromSupplier(supplier), 250)).status).toBeLessThan(300);
    const r = await refund(request, headers, loss.id, fromProvider(provider), 1);
    expect(r.status).toBe(400);
    expect(r.code).toBe('REFUND_EXCEEDS_LOSS');
    expect(r.params).toEqual(expect.objectContaining({ cost: '550.00', refunded: '550.00', asked: '1.00' }));
    const read = await lossRead(request, headers, cycle.id, loss.id);
    expect(read.refundedEgp).toBe('550.00');
    expect(read.unrecoveredEgp).toBe('0.00');
  });

  test('TC-LR-02: A refund in USD at FX 50 of 12 → 600 EGP against a 550 loss → refused', async ({ request }) => {
    const { headers, loss, provider } = await cycleWithALoss(request);
    const r = await refund(request, headers, loss.id, fromProvider(provider), 12, { currency: 'USD', fxRateToEgp: 50 });
    expect(r.code).toBe('REFUND_EXCEEDS_LOSS');
    expect(r.params).toEqual(expect.objectContaining({ asked: '600.00' }));
    const ok = await refund(request, headers, loss.id, fromProvider(provider), 11, { currency: 'USD', fxRateToEgp: 50 });
    expect(ok.status, JSON.stringify(ok.body)).toBeLessThan(300);
  });

  test('TC-LR-03: Two refunds of 300 against a 550 loss at once → one succeeds, the other REFUND_EXCEEDS_LOSS, not a 500', async ({ request }) => {
    const { headers, cycle, loss, provider } = await cycleWithALoss(request);
    const results = await Promise.all([0, 1].map(() =>
      refund(request, headers, loss.id, fromProvider(provider), 300)));
    expect(results.map((r) => r.status).sort()).toEqual([201, 400]);
    expect(results.find((r) => r.status === 400)!.code).toBe('REFUND_EXCEEDS_LOSS');
    expect((await lossRead(request, headers, cycle.id, loss.id)).refunds).toHaveLength(1);
  });
});

test.describe('a loss refund in profit (§6, §9)', () => {
  test('TC-LR-10: A refund raises cycle profit by its EGP in settlement and analytics alike, and appears as an INFLOW loss_refund with the cycle id', async ({ request }) => {
    const { headers, cycle, loss, provider } = await cycleWithALoss(request);
    const preview = async () =>
      (await (await request.get(`${API}/settlements/preview/${cycle.id}`, { headers })).json()).data;
    const before = await preview();

    const r = await refund(request, headers, loss.id, fromProvider(provider), 4, { currency: 'USD', fxRateToEgp: 50 });
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);

    const ledger = await (await request.get(`${API}/ledger?cycleId=${cycle.id}&limit=50`, { headers })).json();
    const rows: any[] = ledger.data?.items ?? ledger.data ?? [];
    const row = rows.find((t) => t.category === 'loss_refund');
    expect(row).toEqual(expect.objectContaining({ direction: 'INFLOW', currency: 'EGP' }));
    expect(Number(row.amount)).toBe(200);
    expect(row.cycleId ?? row.cycle?.id).toBe(cycle.id);

    const after = await preview();
    if (before && after) {
      expect(Number(after.grossProfitEgp) - Number(before.grossProfitEgp)).toBeCloseTo(200, 2);
    }
  });
});

test.describe('dates and amounts (rule 1)', () => {
  test('TC-LR-20: Dated tomorrow (Cairo) → DATE_IN_FUTURE; the same now applies to a plain supplier refund', async ({ request }) => {
    const { headers, loss, provider, po } = await cycleWithALoss(request);
    const r = await refund(request, headers, loss.id, fromProvider(provider), 100, { recordedOn: tomorrow() });
    expect(r.code).toBe('DATE_IN_FUTURE');
    const plain = await post(request, headers, `purchases/${po.id}/refunds`, {
      amount: 100, currency: 'EGP', fxRateToEgp: 1, recordedOn: tomorrow(),
    });
    expect(plain.code).toBe('DATE_IN_FUTURE');
  });

  test('TC-LR-21: Amount 0 or negative → refused', async ({ request }) => {
    const { headers, cycle, loss, provider } = await cycleWithALoss(request);
    for (const amount of [0, -50]) {
      const r = await refund(request, headers, loss.id, fromProvider(provider), amount);
      expect(r.status).toBe(400);
      expect(r.code).toBe('VALIDATION_FAILED');
    }
    expect((await lossRead(request, headers, cycle.id, loss.id)).refunds).toHaveLength(0);
  });
});

test.describe('who can pay (the wrong owner)', () => {
  test('TC-LR-30: An unknown loss id → 404; a payer that is neither the leg’s provider nor the order’s supplier → 404', async ({ request }) => {
    const { headers, loss, provider } = await cycleWithALoss(request);
    const other = await cycleWithALoss(request);

    const unknown = await refund(request, headers, '00000000-0000-4000-8000-000000000000', fromProvider(provider), 10);
    expect(unknown.status).toBe(404);
    const garbage = await refund(request, headers, 'not-a-loss', fromProvider(provider), 10);
    expect(garbage.status).toBe(404);

    const otherCompany = await refund(request, headers, loss.id, fromProvider(other.provider), 10);
    expect(otherCompany.status).toBe(404);
    expect(otherCompany.params).toEqual(expect.objectContaining({ entity: 'provider' }));
    const otherSupplier = await refund(request, headers, loss.id, fromSupplier(other.supplier), 10);
    expect(otherSupplier.status).toBe(404);
    expect(otherSupplier.params).toEqual(expect.objectContaining({ entity: 'supplier' }));
  });

  test('TC-LR-31: Investor or shop token → refused with a code', async ({ request }) => {
    const { loss, provider } = await cycleWithALoss(request);
    for (const role of ['TEMP_INVESTOR', 'SHOP_OWNER_PORTAL']) {
      const headers = await accountWithRole(request, role);
      const r = await refund(request, headers, loss.id, fromProvider(provider), 10);
      expect(r.status).toBe(403);
      expect(r.code).toBe('ROLE_NOT_ALLOWED');
    }
  });
});

test.describe('the order-level cap (§6)', () => {
  test('TC-LR-40: The order-level cap counts loss refunds too: order 1,000, loss refunds 600, plain refund 500 → refused', async ({ request }) => {
    // 10 at 100 and a 400 leg: 140 a unit. 5 lost = 700, so 600 fits the loss.
    const { headers, loss, provider, po } = await cycleWithALoss(request, { ordered: 10, lost: 5 });
    expect(Number(loss.costEgp)).toBe(700);
    expect((await refund(request, headers, loss.id, fromProvider(provider), 600)).status).toBeLessThan(300);
    const plain = await post(request, headers, `purchases/${po.id}/refunds`, {
      amount: 500, currency: 'EGP', fxRateToEgp: 1, recordedOn: today(),
    });
    expect(plain.code).toBe('REFUND_EXCEEDS_ORDER');
  });
});

test.describe('taking a refunded loss back', () => {
  test('TC-LR-50: Taking back a refunded loss → LOSS_REFUNDED', async ({ request }) => {
    const { headers, cycle, loss, provider } = await cycleWithALoss(request);
    expect((await refund(request, headers, loss.id, fromProvider(provider), 100)).status).toBeLessThan(300);
    const res = await request.delete(`${API}/shipping/losses/${loss.id}`, { headers });
    expect(res.status()).toBe(400);
    expect((await res.json()).error.code).toBe('LOSS_REFUNDED');
    expect(await lossRead(request, headers, cycle.id, loss.id)).toBeTruthy();
  });
});

test.describe('the second time', () => {
  test('TC-LR-60: Double submit → one refund per send, up to the cap', async ({ request }) => {
    const { headers, cycle, loss, provider } = await cycleWithALoss(request);
    // Two identical sends that both fit are two refunds — the dialog's
    // disabled button stops a double click; the server's promise is the cap.
    await Promise.all([0, 1].map(() => refund(request, headers, loss.id, fromProvider(provider), 200)));
    const third = await refund(request, headers, loss.id, fromProvider(provider), 200);
    expect(third.code).toBe('REFUND_EXCEEDS_LOSS');
    const read = await lossRead(request, headers, cycle.id, loss.id);
    expect(read.refunds).toHaveLength(2);
    expect(read.unrecoveredEgp).toBe('150.00');
  });
});
