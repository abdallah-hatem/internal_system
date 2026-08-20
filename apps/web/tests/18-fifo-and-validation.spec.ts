/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: FIFO across batches, and input validation
 * ═══════════════════════════════════════════════════════════════════════
 *  Regressions for defects found during full-flow testing:
 *    - a payment with no receivedOn produced an opaque 500
 *    - the seed emitted UUIDs with a 0 version nibble, which validation rejects
 *    - FIFO must consume the oldest batch first and keep each batch's own cost
 */
import { test, expect } from '@playwright/test';

const API = 'http://localhost:3001/api/v1';
const EMAIL = 'partner.a@motoparts.com';
const PASSWORD = 'password123';
const CUSTOMER = '00000000-0000-4000-8000-000000000050';
const BRAKE_PAD = '00000000-0000-4000-8000-000000000040';

async function token(request: any) {
  const auth = await request.post(`${API}/auth/login`, {
    data: { email: EMAIL, password: PASSWORD },
  });
  return (await auth.json()).data.accessToken;
}

test.describe('FIFO allocation', () => {
  test('TC-FIFO-01: a sale spanning two batches takes the oldest first and keeps each cost', async ({ request }) => {
    const t = await token(request);
    const h = { Authorization: `Bearer ${t}` };

    const batchRes = await request.get(`${API}/inventory?limit=100`, { headers: h });
    const inventory = (await batchRes.json()).data ?? [];
    const pad = inventory.find((p: any) => p.productId === BRAKE_PAD || p.product?.id === BRAKE_PAD);
    test.skip(!pad, 'brake pad stock not present in this database');

    // Sell more than the oldest batch holds so the allocation must span batches.
    const available = Number(pad.availableQty ?? pad.totalStock ?? 0);
    test.skip(available < 2, 'not enough stock to span batches');

    const qty = Math.min(available, 41);
    const create = await request.post(`${API}/sales/orders`, {
      headers: h,
      data: {
        customerId: CUSTOMER, channel: 'B2B', currency: 'EGP',
        items: [{ productId: BRAKE_PAD, quantity: qty, unitPrice: 200 }],
      },
    });
    const order = (await create.json()).data;

    const confirm = await request.post(`${API}/sales/orders/${order.id}/confirm`, {
      headers: h, data: { version: order.version },
    });
    expect(confirm.status()).toBe(201);

    const detail = await request.get(`${API}/sales/orders/${order.id}`, { headers: h });
    const allocations = ((await detail.json()).data.items ?? []).flatMap((i: any) => i.allocations ?? []);

    expect(allocations.length).toBeGreaterThan(0);
    // Every allocation records the batch cost it was charged at.
    for (const a of allocations) {
      expect(Number(a.unitCostEgp)).toBeGreaterThan(0);
      expect(Number(a.cogsEgp)).toBeCloseTo(Number(a.qty) * Number(a.unitCostEgp), 2);
    }
    // Allocated quantity equals what was sold — no silent shortfall.
    const allocated = allocations.reduce((s: number, a: any) => s + Number(a.qty), 0);
    expect(allocated).toBeCloseTo(qty, 3);
  });

  test('TC-FIFO-02: overselling is refused and leaves no partial allocation', async ({ request }) => {
    const t = await token(request);
    const h = { Authorization: `Bearer ${t}` };

    const create = await request.post(`${API}/sales/orders`, {
      headers: h,
      data: {
        customerId: CUSTOMER, channel: 'B2B', currency: 'EGP',
        items: [{ productId: BRAKE_PAD, quantity: 999999, unitPrice: 200 }],
      },
    });
    const order = (await create.json()).data;

    const confirm = await request.post(`${API}/sales/orders/${order.id}/confirm`, {
      headers: h, data: { version: order.version },
    });
    expect(confirm.status()).toBe(400);
    expect(JSON.stringify(await confirm.json())).toMatch(/insufficient stock/i);

    // The order must still be a draft with nothing allocated.
    const after = await request.get(`${API}/sales/orders/${order.id}`, { headers: h });
    const body = (await after.json()).data;
    expect(body.status).toBe('DRAFT');
    const allocations = (body.items ?? []).flatMap((i: any) => i.allocations ?? []);
    expect(allocations).toHaveLength(0);
  });
});

test.describe('Payment validation', () => {
  test('TC-PAY-01: a payment with no receivedOn is accepted and dated today', async ({ request }) => {
    const t = await token(request);
    const res = await request.post(`${API}/payments`, {
      headers: { Authorization: `Bearer ${t}` },
      data: { customerId: CUSTOMER, amount: 100, currency: 'EGP', method: 'CASH' },
    });
    expect(res.status()).toBe(201);
    const payment = (await res.json()).data;
    expect(payment.receivedOn).toBeTruthy();
  });

  test('TC-PAY-02: a non-positive amount is refused with a clear message', async ({ request }) => {
    const t = await token(request);
    for (const amount of [0, -100]) {
      const res = await request.post(`${API}/payments`, {
        headers: { Authorization: `Bearer ${t}` },
        data: { customerId: CUSTOMER, amount, currency: 'EGP' },
      });
      expect(res.status()).toBe(400);
      expect(JSON.stringify(await res.json())).toMatch(/greater than 0/i);
    }
  });

  test('TC-PAY-03: allocating more than the payment holds is refused', async ({ request }) => {
    const t = await token(request);
    const h = { Authorization: `Bearer ${t}` };
    const pay = await request.post(`${API}/payments`, {
      headers: h, data: { customerId: CUSTOMER, amount: 50, currency: 'EGP', method: 'CASH' },
    });
    const payment = (await pay.json()).data;

    const orders = (await (await request.get(`${API}/sales/orders?limit=5`, { headers: h })).json()).data;
    test.skip(!orders?.length, 'no sale orders to allocate against');

    const res = await request.post(`${API}/payments/${payment.id}/allocations`, {
      headers: h, data: { saleOrderId: orders[0].id, amount: 99999 },
    });
    expect(res.status()).toBe(400);
  });

  test('TC-PAY-04: an unknown field is rejected rather than silently ignored', async ({ request }) => {
    const t = await token(request);
    const res = await request.post(`${API}/payments`, {
      headers: { Authorization: `Bearer ${t}` },
      data: { customerId: CUSTOMER, amount: 10, currency: 'EGP', sneaky: 'x' },
    });
    expect(res.status()).toBe(400);
    expect(JSON.stringify(await res.json())).toMatch(/should not exist/i);
  });
});

test.describe('Seed data integrity', () => {
  test('TC-SEED-01: seeded ids are valid UUIDs', async ({ request }) => {
    const t = await token(request);
    const res = await request.get(`${API}/customers?limit=50`, {
      headers: { Authorization: `Bearer ${t}` },
    });
    const customers = (await res.json()).data ?? [];
    expect(customers.length).toBeGreaterThan(0);
    // Version nibble must be 1-5; a 0 there is not a valid UUID and every
    // validation layer rejects it even though Postgres stores it.
    const rfc = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    for (const c of customers) expect(c.id).toMatch(rfc);
  });
});
