/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: Where every ordered unit is — GET /cycles/:id/shipment
 * ═══════════════════════════════════════════════════════════════════════
 *  Goods leave in one shipment and arrive in deliveries, weeks apart
 *  (BUSINESS_LOGIC §1, 2026-10-10). This endpoint reads the one function that
 *  says, per leg and order line, what entered, was delivered, received, lost
 *  and is still on the way. Its arithmetic is unit-tested in
 *  apps/api/src/common/shipment-position.spec.ts; this suite is the refusals
 *  and the shape, through the real API (plan B1).
 *
 *  Recording deliveries arrives with B2. Until then a cycle here has none, so
 *  these cases do not assert on delivered quantities.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { apiCtx, API, investorSession, today } from './support/fixtures';

async function accountWithRole(request: APIRequestContext, role: string) {
  const { headers } = await apiCtx(request);
  const stamp = `${Date.now()}${Math.floor(performance.now() % 1000)}`;
  const email = `shipment-${role.toLowerCase()}-${stamp}@motoparts.com`;
  const made = await request.post(`${API}/auth/register`, {
    headers,
    data: { email, password: 'password123', displayName: `Shipment ${stamp}`, role },
  });
  expect(made.ok(), `create ${role}: ${await made.text()}`).toBeTruthy();
  const signedIn = await request.post(`${API}/auth/login`, {
    data: { email, password: 'password123' },
  });
  return { Authorization: `Bearer ${(await signedIn.json()).data.accessToken}` };
}

/** A cycle with one order line of 40 and its one leg, nothing yet arrived. */
async function orderedCycle(request: APIRequestContext) {
  const { headers, mk } = await apiCtx(request);
  const stamp = Date.now();
  const product = await mk('products', { name: `Shipment ${stamp} Part`, minStock: 0 });
  const supplier = await mk('suppliers', { name: `Shipment ${stamp} Supplier`, country: 'AE' });
  const cycle = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'EGP' });
  await mk(`cycles/${cycle.id}/purchases`, {
    supplierId: supplier.id, currency: 'EGP', fxRateToEgp: 1, orderedOn: today(),
    items: [{ productId: product.id, orderedQty: 40, unitPrice: 10 }],
  });
  await mk(`cycles/${cycle.id}/shipping-legs`, {
    sequence: 1, origin: 'Dubai, UAE', destination: 'Cairo, Egypt',
    provider: `Shipment ${stamp} Freight`, costBasis: 'FLAT', amount: 0, currency: 'EGP', fxRateToEgp: 1,
  });
  return { headers, cycle, product };
}

test.describe('GET /cycles/:id/shipment', () => {
  test('TC-SHIP-01: an unknown cycle id → 404 NOT_FOUND (cycle), not 500', async ({ request }) => {
    const { headers } = await apiCtx(request);
    const res = await request.get(
      `${API}/cycles/00000000-0000-4000-8000-000000000000/shipment`,
      { headers },
    );
    expect(res.status()).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.params.entity).toBe('cycle');
  });

  test('TC-SHIP-02: an id that is not a uuid → 404, not 500', async ({ request }) => {
    const { headers } = await apiCtx(request);
    const res = await request.get(`${API}/cycles/not-a-cycle/shipment`, { headers });
    expect(res.status()).toBe(404);
    expect((await res.json()).error.code).toBe('NOT_FOUND');
  });

  test('TC-SHIP-03: as ADMIN_SUPPORT → refused with ROLE_NOT_ALLOWED', async ({ request }) => {
    const { cycle } = await orderedCycle(request);
    const headers = await accountWithRole(request, 'ADMIN_SUPPORT');
    const res = await request.get(`${API}/cycles/${cycle.id}/shipment`, { headers });
    expect(res.status()).toBe(403);
    expect((await res.json()).error.code).toBe('ROLE_NOT_ALLOWED');
  });

  test('TC-SHIP-03b: as a TEMP_INVESTOR not on the cycle → 404, as if it did not exist', async ({ request }) => {
    // R1 (owner's decision 2026-10-10): an investor reads their own cycles'
    // shipments, and another cycle is NOT_FOUND rather than 403, so its
    // existence is not disclosed. The investor-on-the-cycle 200 is spec 87.
    const { cycle } = await orderedCycle(request);
    // An investor cannot sign in at the office (2026-10-19); investorSession's token reaches the scope check.
    const { headers } = await investorSession(request, 'ship');
    const res = await request.get(`${API}/cycles/${cycle.id}/shipment`, { headers });
    expect(res.status()).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.params.entity).toBe('cycle');
  });

  test('TC-SHIP-04: with no token → 401', async ({ request }) => {
    const res = await request.get(
      `${API}/cycles/00000000-0000-4000-8000-000000000000/shipment`,
    );
    expect(res.status()).toBe(401);
  });

  test('TC-SHIP-05: as a core partner → the position: 40 ordered, all still waiting at the leg’s origin (it has not left — L8)', async ({
    request,
  }) => {
    // The other direction of the role check: a guard that refuses everybody
    // passes the refusal tests above (CLAUDE.md rule 12).
    const { headers, cycle, product } = await orderedCycle(request);
    const res = await request.get(`${API}/cycles/${cycle.id}/shipment`, { headers });
    expect(res.status()).toBe(200);
    const { data } = await res.json();
    expect(data.cycleId).toBe(cycle.id);
    expect(data.accounted).toBe(false);
    // Nothing has left, so nothing is on the way: it all waits in Dubai (L8).
    expect(data.totals).toEqual({ ordered: 40, received: 0, lost: 0, atOrigin: 40, onTheWay: 0, waiting: 0 });
    expect(data.lines).toHaveLength(1);
    expect(data.lines[0].productId).toBe(product.id);
    expect(data.legs).toHaveLength(1);
    expect(data.legs[0]).toMatchObject({
      sequence: 1,
      isLast: true,
      status: 'PENDING',
      entered: 40,
      atOrigin: 40,
      onTheWay: 0,
      departures: [],
      deliveries: [],
    });
  });

  test('TC-SHIP-06: a cycle with nothing ordered reads accounted', async ({ request }) => {
    const { headers, mk } = await apiCtx(request);
    const cycle = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'EGP' });
    const res = await request.get(`${API}/cycles/${cycle.id}/shipment`, { headers });
    expect(res.status()).toBe(200);
    const { data } = await res.json();
    expect(data.accounted).toBe(true);
    expect(data.lines).toEqual([]);
  });
});
