/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: A shipping leg's status follows its cycle
 * ═══════════════════════════════════════════════════════════════════════
 *  Nothing ever set a leg's status. Every leg stayed PENDING for good, so a
 *  cycle could reach Egypt, have its stock received and sold, while the
 *  shipment record still said the goods had not left the supplier — two
 *  screens describing the same shipment and disagreeing about where it was.
 *
 *  The cycle's status is what the wizard actually drives, so the legs follow
 *  it rather than being kept up by hand.
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
  await mk(`cycles/${cycle.id}/shipping-legs`, {
    sequence: 1, origin: 'Guangzhou, CN', destination: 'Dubai, UAE',
    provider: 'Sea', costBasis: 'FLAT', amount: 300, currency: 'USD', fxRateToEgp: 50.86,
  });
  await mk(`cycles/${cycle.id}/shipping-legs`, {
    sequence: 2, origin: 'Dubai, UAE', destination: 'Cairo, Egypt',
    provider: 'Air', costBasis: 'FLAT', amount: 200, currency: 'AED', fxRateToEgp: 13.85,
  });
  return { headers, mk, cycle, product };
}

test.describe('Shipping legs follow the cycle', () => {
  test('TC-LEG-01: a China cycle moves each leg in turn', async ({ request }) => {
    const { headers, mk, cycle } = await chinaCycle(request);
    expect(await legStatuses(request, headers, cycle.id)).toEqual(['PENDING', 'PENDING']);

    await mk(`cycles/${cycle.id}/transition`, { status: 'FUNDING' });
    await mk(`cycles/${cycle.id}/transition`, { status: 'PURCHASING' });
    // Nothing has moved yet.
    expect(await legStatuses(request, headers, cycle.id)).toEqual(['PENDING', 'PENDING']);

    await mk(`cycles/${cycle.id}/transition`, { status: 'IN_TRANSIT' });
    expect(await legStatuses(request, headers, cycle.id)).toEqual(['IN_TRANSIT', 'PENDING']);

    await mk(`cycles/${cycle.id}/transition`, { status: 'ARRIVED_UAE' });
    expect(await legStatuses(request, headers, cycle.id)).toEqual(['ARRIVED', 'PENDING']);

    await mk(`cycles/${cycle.id}/transition`, { status: 'IN_TRANSIT_TO_EGYPT' });
    expect(await legStatuses(request, headers, cycle.id)).toEqual(['ARRIVED', 'IN_TRANSIT']);

    await mk(`cycles/${cycle.id}/transition`, { status: 'ARRIVED_EGYPT' });
    expect(await legStatuses(request, headers, cycle.id)).toEqual(['ARRIVED', 'ARRIVED']);
  });

  test('TC-LEG-02: a UAE-direct leg does not move at ARRIVED_UAE', async ({ request }) => {
    // Its one leg is UAE→Egypt, so goods sitting in the UAE have not started.
    // Treating ARRIVED_UAE the same for both routes would mark it arrived
    // before it had left.
    const { headers, mk } = await apiCtx(request);
    const cycle = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'AED' });
    await mk(`cycles/${cycle.id}/shipping-legs`, {
      sequence: 1, origin: 'Dubai, UAE', destination: 'Cairo, Egypt',
      provider: 'Air', costBasis: 'FLAT', amount: 100, currency: 'AED', fxRateToEgp: 13.85,
    });

    for (const status of ['FUNDING', 'PURCHASING', 'ARRIVED_UAE']) {
      await mk(`cycles/${cycle.id}/transition`, { status });
    }
    expect(await legStatuses(request, headers, cycle.id)).toEqual(['PENDING']);

    await mk(`cycles/${cycle.id}/transition`, { status: 'IN_TRANSIT_TO_EGYPT' });
    expect(await legStatuses(request, headers, cycle.id)).toEqual(['IN_TRANSIT']);

    await mk(`cycles/${cycle.id}/transition`, { status: 'ARRIVED_EGYPT' });
    expect(await legStatuses(request, headers, cycle.id)).toEqual(['ARRIVED']);
  });

  test('TC-LEG-03: stock is never received while a leg says it has not arrived', async ({
    request,
  }) => {
    // The state the owner noticed: goods in stock and sellable while the
    // shipment record still read PENDING.
    const { headers, mk, cycle, product } = await chinaCycle(request);
    for (const status of ['FUNDING', 'PURCHASING', 'IN_TRANSIT', 'ARRIVED_UAE', 'IN_TRANSIT_TO_EGYPT', 'ARRIVED_EGYPT', 'VERIFICATION']) {
      await mk(`cycles/${cycle.id}/transition`, { status });
    }

    // By the time stock can be received, both legs have arrived.
    expect(await legStatuses(request, headers, cycle.id)).toEqual(['ARRIVED', 'ARRIVED']);

    const full = await (await request.get(`${API}/cycles/${cycle.id}`, { headers })).json();
    const poItem = (full.data ?? full).purchaseOrders[0].items[0];
    await mk('receipts/verify', {
      cycleId: cycle.id,
      items: [{ purchaseOrderItemId: poItem.id, productId: product.id, receivedQty: 50 }],
    });

    const after = await (await request.get(`${API}/cycles/${cycle.id}`, { headers })).json();
    expect(((after.data ?? after).inventoryBatches ?? []).length).toBe(1);
    expect(await legStatuses(request, headers, cycle.id)).toEqual(['ARRIVED', 'ARRIVED']);
  });

  test('TC-LEG-04: a leg is never pulled backwards', async ({ request }) => {
    // Someone who corrects a leg on the shipments page should not have it
    // silently undone by the next cycle transition.
    const { headers, mk, cycle } = await chinaCycle(request);
    await mk(`cycles/${cycle.id}/transition`, { status: 'FUNDING' });

    const legs = await (await request.get(`${API}/cycles/${cycle.id}/shipping-legs`, { headers })).json();
    const first = (legs.data ?? [])[0];
    await request.put(`${API}/shipping/legs/${first.id}`, {
      headers, data: { status: 'ARRIVED' },
    });

    // PURCHASING would map this leg to nothing, and IN_TRANSIT to a lower rank.
    await mk(`cycles/${cycle.id}/transition`, { status: 'PURCHASING' });
    await mk(`cycles/${cycle.id}/transition`, { status: 'IN_TRANSIT' });

    const statuses = await legStatuses(request, headers, cycle.id);
    expect(statuses[0]).toBe('ARRIVED');
  });

  test('TC-LEG-05: a cycle with no legs transitions without complaint', async ({ request }) => {
    // Legs are added part-way through the wizard, so early transitions happen
    // when there is nothing to advance.
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
});
