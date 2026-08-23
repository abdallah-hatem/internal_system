/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: A shipping leg's status follows its cycle
 * ═══════════════════════════════════════════════════════════════════════
 *  Nothing ever set a leg's status. Every leg stayed PENDING for good, so a
 *  cycle could reach Egypt, have its stock received and sold, while the
 *  shipment record still said the goods had not left the supplier.
 *
 *  A first attempt had the cycle push the legs forward, which was backwards:
 *  it invented arrivals nobody had recorded, and completing the wizard still
 *  moved goods from ordered to sellable in one click.
 *
 *  The dates are the record. A leg is in transit once it has a departure date
 *  and arrived once it has an arrival date, and the cycle cannot pass a point
 *  its goods have not reached.
 */
import { test, expect, APIRequestContext } from '@playwright/test';
import { apiCtx, today, API } from './support/fixtures';

async function legStatuses(request: APIRequestContext, headers: any, cycleId: string) {
  const res = await request.get(`${API}/cycles/${cycleId}/shipping-legs`, { headers });
  const legs = (await res.json()).data ?? [];
  return legs
    .sort((a: any, b: any) => a.sequence - b.sequence)
    .map((l: any) => l.status);
}

/** A China cycle with both legs recorded. */
async function chinaCycle(request: APIRequestContext) {
  const { headers, mk } = await apiCtx(request);
  const stamp = Date.now();
  const supplier = await mk('suppliers', { name: `Leg Sup ${stamp}`, country: 'CN' });
  const product = await mk('products', { name: `Leg Part ${stamp}`, minStock: 0 });
  const cycle = await mk('cycles', { originType: 'CHINA', currency: 'USD' });

  await mk(`cycles/${cycle.id}/purchases`, {
    supplierId: supplier.id, currency: 'USD', fxRateToEgp: 50.86, orderedOn: today(),
    items: [{ productId: product.id, orderedQty: 50, unitPrice: 4 }],
  });
  const first = await mk(`cycles/${cycle.id}/shipping-legs`, {
    sequence: 1, origin: 'Guangzhou, CN', destination: 'Dubai, UAE',
    provider: 'Sea', costBasis: 'FLAT', amount: 300, currency: 'USD', fxRateToEgp: 50.86,
  });
  const second = await mk(`cycles/${cycle.id}/shipping-legs`, {
    sequence: 2, origin: 'Dubai, UAE', destination: 'Cairo, Egypt',
    provider: 'Air', costBasis: 'FLAT', amount: 200, currency: 'AED', fxRateToEgp: 13.85,
  });
  return { headers, mk, cycle, product, legIds: [first.id, second.id] };
}

test.describe('Shipping legs follow their dates', () => {
  test('TC-LEG-01: a leg is pending until it has a departure date', async ({ request }) => {
    const { headers, cycle, legIds } = await chinaCycle(request);
    expect(await legStatuses(request, headers, cycle.id)).toEqual(['PENDING', 'PENDING']);

    await request.put(`${API}/shipping/legs/${legIds[0]}`, {
      headers, data: { departedOn: '2026-08-10' },
    });
    expect(await legStatuses(request, headers, cycle.id)).toEqual(['IN_TRANSIT', 'PENDING']);

    await request.put(`${API}/shipping/legs/${legIds[0]}`, {
      headers, data: { arrivedOn: '2026-08-18' },
    });
    expect(await legStatuses(request, headers, cycle.id)).toEqual(['ARRIVED', 'PENDING']);
  });

  test('TC-LEG-02: the cycle cannot pass a point the shipment has not reached', async ({
    request,
  }) => {
    // The heart of it: approving a cycle used to move goods from ordered to
    // sellable in one click, with no date recorded anywhere.
    const { headers, mk, cycle, legIds } = await chinaCycle(request);
    await mk(`cycles/${cycle.id}/transition`, { status: 'FUNDING' });
    await mk(`cycles/${cycle.id}/transition`, { status: 'PURCHASING' });

    const inTransit = await request.post(`${API}/cycles/${cycle.id}/transition`, {
      headers, data: { status: 'IN_TRANSIT' },
    });
    expect(inTransit.status()).toBe(400);
    expect(JSON.stringify(await inTransit.json())).toMatch(/has not departed/i);

    await request.put(`${API}/shipping/legs/${legIds[0]}`, {
      headers, data: { departedOn: '2026-08-10' },
    });
    const nowOk = await request.post(`${API}/cycles/${cycle.id}/transition`, {
      headers, data: { status: 'IN_TRANSIT' },
    });
    expect(nowOk.ok(), await nowOk.text()).toBeTruthy();

    // And it cannot land in the UAE until that leg has an arrival date.
    const arrived = await request.post(`${API}/cycles/${cycle.id}/transition`, {
      headers, data: { status: 'ARRIVED_UAE' },
    });
    expect(arrived.status()).toBe(400);
    expect(JSON.stringify(await arrived.json())).toMatch(/has not arrived/i);
  });

  test('TC-LEG-03: reaching Egypt needs every leg arrived', async ({ request }) => {
    const { headers, mk, cycle, legIds } = await chinaCycle(request);
    for (const status of ['FUNDING', 'PURCHASING']) {
      await mk(`cycles/${cycle.id}/transition`, { status });
    }
    await request.put(`${API}/shipping/legs/${legIds[0]}`, {
      headers, data: { departedOn: '2026-08-01', arrivedOn: '2026-08-08' },
    });
    await mk(`cycles/${cycle.id}/transition`, { status: 'IN_TRANSIT' });
    await mk(`cycles/${cycle.id}/transition`, { status: 'ARRIVED_UAE' });

    await request.put(`${API}/shipping/legs/${legIds[1]}`, {
      headers, data: { departedOn: '2026-08-10' },
    });
    await mk(`cycles/${cycle.id}/transition`, { status: 'IN_TRANSIT_TO_EGYPT' });

    // The second leg is still in the air.
    const early = await request.post(`${API}/cycles/${cycle.id}/transition`, {
      headers, data: { status: 'ARRIVED_EGYPT' },
    });
    expect(early.status()).toBe(400);

    await request.put(`${API}/shipping/legs/${legIds[1]}`, {
      headers, data: { arrivedOn: '2026-08-16' },
    });
    const landed = await request.post(`${API}/cycles/${cycle.id}/transition`, {
      headers, data: { status: 'ARRIVED_EGYPT' },
    });
    expect(landed.ok(), await landed.text()).toBeTruthy();
    expect(await legStatuses(request, headers, cycle.id)).toEqual(['ARRIVED', 'ARRIVED']);
  });

  test('TC-LEG-04: impossible dates are refused', async ({ request }) => {
    const { headers, legIds } = await chinaCycle(request);

    // Arriving without ever having left.
    const orphan = await request.put(`${API}/shipping/legs/${legIds[0]}`, {
      headers, data: { arrivedOn: '2026-08-10' },
    });
    expect(orphan.status()).toBe(400);
    expect(JSON.stringify(await orphan.json())).toMatch(/without a departure/i);

    // Arriving before departing.
    await request.put(`${API}/shipping/legs/${legIds[0]}`, {
      headers, data: { departedOn: '2026-08-10' },
    });
    const backwards = await request.put(`${API}/shipping/legs/${legIds[0]}`, {
      headers, data: { arrivedOn: '2026-08-05' },
    });
    expect(backwards.status()).toBe(400);
    expect(JSON.stringify(await backwards.json())).toMatch(/before it departed/i);
  });

  test('TC-LEG-05: a UAE-direct leg does not move at ARRIVED_UAE', async ({ request }) => {
    // Its one leg is UAE→Egypt, so goods sitting in the UAE have not started.
    const { headers, mk } = await apiCtx(request);
    const cycle = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'AED' });
    await mk(`cycles/${cycle.id}/shipping-legs`, {
      sequence: 1, origin: 'Dubai, UAE', destination: 'Cairo, Egypt',
      provider: 'Air', costBasis: 'FLAT', amount: 100, currency: 'AED', fxRateToEgp: 13.85,
    });

    for (const status of ['FUNDING', 'PURCHASING', 'ARRIVED_UAE']) {
      const res = await request.post(`${API}/cycles/${cycle.id}/transition`, {
        headers, data: { status },
      });
      expect(res.ok(), `${status}: ${await res.text()}`).toBeTruthy();
    }
    expect(await legStatuses(request, headers, cycle.id)).toEqual(['PENDING']);
  });

  test('TC-LEG-06: a cycle with no legs transitions without complaint', async ({ request }) => {
    // Legs are added part-way through the wizard, so the early steps happen
    // when there is nothing to check.
    const { headers, mk } = await apiCtx(request);
    const cycle = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'EGP' });

    for (const status of ['FUNDING', 'PURCHASING', 'ARRIVED_UAE']) {
      const res = await request.post(`${API}/cycles/${cycle.id}/transition`, {
        headers, data: { status },
      });
      expect(res.ok(), await res.text()).toBeTruthy();
    }
    expect(await legStatuses(request, headers, cycle.id)).toEqual([]);
  });

  test('TC-LEG-07: a departure date cannot be in the future', async ({ request }) => {
    const { headers, legIds } = await chinaCycle(request);
    const future = new Date();
    future.setDate(future.getDate() + 20);
    const iso = future.toISOString().slice(0, 10);

    const res = await request.put(`${API}/shipping/legs/${legIds[0]}`, {
      headers, data: { departedOn: iso },
    });
    expect(res.status()).toBe(400);
    expect(JSON.stringify(await res.json())).toMatch(/future/i);
  });
});
