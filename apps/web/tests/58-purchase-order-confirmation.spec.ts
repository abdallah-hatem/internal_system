import { test, expect } from '@playwright/test';

import { API, apiCtx, daysAgo } from './support/fixtures';

/**
 * A purchase order stops being a draft when the goods start moving.
 *
 * Found by the production audit, not by a feature test: every purchase order
 * created through the app was still DRAFT — through shipping, arrival,
 * verification and selling. Only the demo seeder ever wrote CONFIRMED, which is
 * why a seeded database looked right and every real one was wrong.
 *
 * The label was never the point. `addItem` refuses on a non-DRAFT order, and
 * with nothing ever leaving DRAFT that guard had not once fired in production.
 * Lines could be added to an order after its stock had been received and its
 * landed cost computed — the exact shape of the money bugs CLAUDE.md was
 * written after.
 *
 * PURCHASING -> IN_TRANSIT or ARRIVED_UAE both mean the goods are on their way,
 * so the order exists in the world and can no longer gain lines.
 */

const stamp = () => Math.random().toString(36).slice(2, 8);

/** A cycle with one supplier and one purchase order, sitting in PURCHASING. */
async function cycleInPurchasing(
  request: any,
  mk: any,
  label: string,
  { withItems = true }: { withItems?: boolean } = {},
) {
  const supplier = await mk('suppliers', { name: `${label} Supplier`, country: 'AE' });
  const product = await mk('products', { name: `${label} Part`, minStock: 0 });
  const cycle = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'EGP' });

  await mk(`cycles/${cycle.id}/purchases`, {
    supplierId: supplier.id,
    currency: 'EGP',
    fxRateToEgp: 1,
    orderedOn: daysAgo(10),
    items: withItems ? [{ productId: product.id, orderedQty: 10, unitPrice: 25 }] : [],
  });

  await mk(`cycles/${cycle.id}/shipping-legs`, {
    sequence: 1,
    origin: 'Dubai, UAE',
    destination: 'Cairo, Egypt',
    provider: `${label} Freight`,
    costBasis: 'FLAT',
    amount: 0,
    currency: 'EGP',
    fxRateToEgp: 1,
    departedOn: daysAgo(8),
    arrivedOn: daysAgo(3),
  });

  await mk(`cycles/${cycle.id}/transition`, { status: 'FUNDING' });
  await mk(`cycles/${cycle.id}/transition`, { status: 'PURCHASING' });

  return { cycle, supplier, product };
}

async function purchaseOrdersOf(request: any, headers: any, cycleId: string) {
  const res = await request.get(`${API}/cycles/${cycleId}`, { headers });
  return ((await res.json()).data ?? {}).purchaseOrders ?? [];
}

test.describe('Purchase order confirmation', () => {
  test('TC-PO-01: leaving purchasing confirms the order', async ({ request }) => {
    const { headers, mk } = await apiCtx(request);
    const label = `Conf${stamp()}`;
    const { cycle } = await cycleInPurchasing(request, mk, label);

    // Still a draft while the cycle is buying.
    let pos = await purchaseOrdersOf(request, headers, cycle.id);
    expect(pos).toHaveLength(1);
    expect(pos[0].status, 'should still be a draft during purchasing').toBe('DRAFT');

    await mk(`cycles/${cycle.id}/transition`, { status: 'ARRIVED_UAE' });

    pos = await purchaseOrdersOf(request, headers, cycle.id);
    expect(pos[0].status, 'the order was not confirmed when the goods moved').toBe('CONFIRMED');
  });

  test('TC-PO-02: a confirmed order cannot gain another line', async ({ request }) => {
    // The reason any of this matters. Before the fix this succeeded, so an
    // order could grow after its stock was received and costed.
    const { headers, mk } = await apiCtx(request);
    const label = `Locked${stamp()}`;
    const { cycle, product } = await cycleInPurchasing(request, mk, label);

    const [po] = await purchaseOrdersOf(request, headers, cycle.id);

    // While it is a draft, adding a line is allowed — the guard must not be
    // so eager that it breaks the flow it is protecting.
    const whileDraft = await request.post(`${API}/purchases/items`, {
      headers,
      data: { purchaseOrderId: po.id, productId: product.id, orderedQty: 2, unitPrice: 5 },
    });
    expect(whileDraft.ok(), await whileDraft.text()).toBeTruthy();

    await mk(`cycles/${cycle.id}/transition`, { status: 'ARRIVED_UAE' });

    const afterConfirm = await request.post(`${API}/purchases/items`, {
      headers,
      data: { purchaseOrderId: po.id, productId: product.id, orderedQty: 99, unitPrice: 1 },
    });
    expect(afterConfirm.ok(), 'a confirmed order still accepted a new line').toBeFalsy();
    const err = (await afterConfirm.json()).error;
    expect(err.code).toBe('PO_NOT_DRAFT');
  });

  test('TC-PO-03: an order cannot be created empty in the first place', async ({ request }) => {
    // This began as "an empty order blocks the cycle". It cannot exist to
    // block it: `create` already refuses with PO_NEEDS_ITEM, so an order with
    // no lines never reaches the database through this API.
    //
    // The transition still checks — an order whose only line was somehow
    // removed, or data predating that guard, would otherwise be confirmed into
    // a state where it can never be corrected, because adding a line requires
    // it to be a draft. Defensive, and the assertion belongs on the rule that
    // actually holds.
    const { headers, mk } = await apiCtx(request);
    const label = `Empty${stamp()}`;

    const supplier = await mk('suppliers', { name: `${label} Supplier`, country: 'AE' });
    const cycle = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'EGP' });

    const res = await request.post(`${API}/cycles/${cycle.id}/purchases`, {
      headers,
      data: {
        supplierId: supplier.id,
        currency: 'EGP',
        fxRateToEgp: 1,
        orderedOn: daysAgo(10),
        items: [],
      },
    });

    expect(res.ok(), 'an order with no lines was accepted').toBeFalsy();
    expect((await res.json()).error.code).toBe('PO_NEEDS_ITEM');
  });

  test('TC-PO-04: cancelling does not confirm anything', async ({ request }) => {
    // The wrong context. A cycle that was abandoned never placed its orders,
    // and confirming them on the way out would leave a CONFIRMED order for
    // goods nobody bought.
    const { headers, mk } = await apiCtx(request);
    const label = `Cancel${stamp()}`;
    const { cycle } = await cycleInPurchasing(request, mk, label);

    await mk(`cycles/${cycle.id}/transition`, { status: 'CANCELLED' });

    const pos = await purchaseOrdersOf(request, headers, cycle.id);
    expect(pos[0].status, 'a cancelled cycle confirmed its orders').toBe('DRAFT');
  });

  test('TC-PO-05: confirming twice is harmless', async ({ request }) => {
    // The second time. VERIFICATION can go back to ARRIVED_EGYPT and forward
    // again, so this transition is not once-only, and a re-run must not throw
    // or disturb an order that is already confirmed.
    const { headers, mk } = await apiCtx(request);
    const label = `Twice${stamp()}`;
    const { cycle } = await cycleInPurchasing(request, mk, label);

    await mk(`cycles/${cycle.id}/transition`, { status: 'ARRIVED_UAE' });
    const [first] = await purchaseOrdersOf(request, headers, cycle.id);
    expect(first.status).toBe('CONFIRMED');

    await mk(`cycles/${cycle.id}/transition`, { status: 'IN_TRANSIT_TO_EGYPT' });
    await mk(`cycles/${cycle.id}/transition`, { status: 'ARRIVED_EGYPT' });
    await mk(`cycles/${cycle.id}/transition`, { status: 'VERIFICATION' });
    await mk(`cycles/${cycle.id}/transition`, { status: 'ARRIVED_EGYPT' });
    await mk(`cycles/${cycle.id}/transition`, { status: 'VERIFICATION' });

    const [again] = await purchaseOrdersOf(request, headers, cycle.id);
    expect(again.status).toBe('CONFIRMED');
    expect(again.id, 'the order was replaced rather than left alone').toBe(first.id);
  });

  test('TC-PO-06: no cycle past purchasing is left holding a draft', async ({ request }) => {
    // The invariant, asserted over the whole database rather than one fixture.
    // This is the check that failed against production and is what would catch
    // a future path that advances a cycle without going through `transition`.
    const { headers } = await apiCtx(request);

    const res = await request.get(`${API}/cycles?limit=200`, { headers });
    const body = await res.json();
    const cycles = Array.isArray(body.data) ? body.data : (body.data?.items ?? []);

    const past = ['IN_TRANSIT', 'ARRIVED_UAE', 'IN_TRANSIT_TO_EGYPT', 'ARRIVED_EGYPT',
      'VERIFICATION', 'SELLING', 'SETTLEMENT', 'CLOSED'];

    const offenders: string[] = [];
    for (const c of cycles.filter((c: any) => past.includes(c.status))) {
      const pos = await purchaseOrdersOf(request, headers, c.id);
      const drafts = pos.filter((p: any) => p.status === 'DRAFT');
      if (drafts.length > 0) offenders.push(`${c.code} (${c.status}): ${drafts.length} draft`);
    }

    expect(offenders, `cycles past purchasing still holding drafts`).toEqual([]);
  });
});
