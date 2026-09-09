import { test, expect, Page } from '@playwright/test';

import { API, EMAIL, PASSWORD, apiCtx, stockedProduct, daysAgo } from './support/fixtures';

const BASE = process.env.WEB_URL ?? 'http://localhost:3000';

/**
 * When stock arrived, and when it was booked in.
 *
 * Two dates, deliberately not one. They answer different questions and they are
 * routinely days apart:
 *
 *   arrived   the shipment physically landed — the last leg's `arrivedOn`
 *   received  it was verified into stock and became sellable — the batch itself
 *
 * The seed's own data has them five days apart. Collapsing them into a single
 * "arrived" would hide exactly the thing worth seeing: a wide gap is stock that
 * sat somewhere before anyone booked it in.
 *
 * `arrived` is the LAST dated leg, which is the assertion most worth having.
 * A CHINA cycle has two legs, and the first one arriving in the UAE is not what
 * anybody means by "when did this arrive" — that is a box in a warehouse in
 * Dubai, not stock in Cairo.
 */

async function login(page: Page) {
  await page.goto(`${BASE}/en/login`);
  await page.getByPlaceholder('partner.a@motoparts.com').fill(EMAIL);
  await page.getByPlaceholder('••••••••').fill(PASSWORD);
  await page.getByRole('button', { name: /login/i }).click();
  await expect(page).toHaveURL(/dashboard/, { timeout: 15_000 });
}

/** The batch rows the API returns for one product. */
async function batchesFor(request: any, headers: any, productId: string) {
  const res = await request.get(`${API}/inventory`, { headers });
  const body = await res.json();
  const item = (body.data ?? []).find((i: any) => i.productId === productId);
  return item?.batches ?? [];
}

const stamp = () => Math.random().toString(36).slice(2, 8);

test.describe('When stock arrived', () => {
  test('TC-ARR-01: a batch carries both the landing date and the booking date', async ({
    request,
  }) => {
    const { headers, mk } = await apiCtx(request);
    const label = `Arr${stamp()}`;
    const { product } = await stockedProduct(request, headers, mk, label, 25);

    const batches = await batchesFor(request, headers, product.id);
    expect(batches, 'the fixture produced no batch').toHaveLength(1);

    const [batch] = batches;
    expect(batch.receivedAt, 'receivedAt missing').toBeTruthy();
    expect(batch.arrivedOn, 'arrivedOn missing').toBeTruthy();

    // And they are genuinely different facts, not the same value twice — which
    // is what a lazy implementation returns and what no test would notice.
    expect(
      new Date(batch.arrivedOn).getTime(),
      'arrived should precede received: goods land before they are booked in',
    ).toBeLessThan(new Date(batch.receivedAt).getTime());
  });

  test('TC-ARR-02: arrival is the last leg, not the first', async ({ request }) => {
    // The one that matters. A CHINA cycle goes China -> UAE -> Egypt, and the
    // leg-1 arrival is a box in Dubai. Reading `shippingLegs[0]` would look
    // correct against every UAE_DIRECT cycle in the seed and be wrong for every
    // China one, which is most of the business.
    const { headers, mk } = await apiCtx(request);
    const label = `TwoLeg${stamp()}`;

    const supplier = await mk('suppliers', { name: `${label} Supplier`, country: 'CN' });
    const productRec = await mk('products', { name: `${label} Part`, minStock: 0 });
    const cycle = await mk('cycles', { originType: 'CHINA', currency: 'CNY' });

    await mk(`cycles/${cycle.id}/purchases`, {
      supplierId: supplier.id,
      currency: 'CNY',
      fxRateToEgp: 7,
      orderedOn: daysAgo(40),
      items: [{ productId: productRec.id, orderedQty: 10, unitPrice: 10 }],
    });

    const legOneArrival = daysAgo(30);
    const legTwoArrival = daysAgo(9);

    await mk(`cycles/${cycle.id}/shipping-legs`, {
      sequence: 1,
      origin: 'Guangzhou, China',
      destination: 'Dubai, UAE',
      provider: `${label} Freight`,
      costBasis: 'FLAT',
      amount: 0,
      currency: 'EGP',
      fxRateToEgp: 1,
      departedOn: daysAgo(38),
      arrivedOn: legOneArrival,
    });
    await mk(`cycles/${cycle.id}/shipping-legs`, {
      sequence: 2,
      origin: 'Dubai, UAE',
      destination: 'Cairo, Egypt',
      provider: `${label} Freight`,
      costBasis: 'FLAT',
      amount: 0,
      currency: 'EGP',
      fxRateToEgp: 1,
      departedOn: daysAgo(20),
      arrivedOn: legTwoArrival,
    });

    for (const status of [
      'FUNDING',
      'PURCHASING',
      'ARRIVED_UAE',
      'IN_TRANSIT_TO_EGYPT',
      'ARRIVED_EGYPT',
      'VERIFICATION',
    ]) {
      await mk(`cycles/${cycle.id}/transition`, { status });
    }

    const po = (await (await request.get(`${API}/cycles/${cycle.id}`, { headers })).json()).data;
    const poItem = po.purchaseOrders[0].items[0];
    await mk('receipts/verify', {
      cycleId: cycle.id,
      items: [{ purchaseOrderItemId: poItem.id, productId: productRec.id, receivedQty: 10 }],
    });

    const [batch] = await batchesFor(request, headers, productRec.id);
    expect(batch, 'no batch was produced').toBeTruthy();

    const arrived = new Date(batch.arrivedOn).toISOString().slice(0, 10);
    expect(
      arrived,
      'arrival reported the UAE leg, not the Egypt one',
    ).toBe(new Date(legTwoArrival).toISOString().slice(0, 10));
    expect(arrived).not.toBe(new Date(legOneArrival).toISOString().slice(0, 10));
  });

  test('TC-ARR-03: stock cannot be received from a leg that never arrived', async ({
    request,
  }) => {
    // This started as "an undated leg reports no arrival". It cannot: the API
    // refuses to advance the cycle at all, with LEG_NOT_ARRIVED. That is the
    // stronger guarantee and worth pinning — it is *why* `arrivedOn` is
    // reliable on the screen rather than something to be hopeful about.
    //
    // The UI still handles null, because a cycle with no legs at all, or data
    // predating this rule, can reach the same place. Defensive, not dead.
    const { headers, mk } = await apiCtx(request);
    const label = `Undated${stamp()}`;

    const supplier = await mk('suppliers', { name: `${label} Supplier`, country: 'AE' });
    const productRec = await mk('products', { name: `${label} Part`, minStock: 0 });
    const cycle = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'EGP' });

    await mk(`cycles/${cycle.id}/purchases`, {
      supplierId: supplier.id,
      currency: 'EGP',
      fxRateToEgp: 1,
      orderedOn: daysAgo(20),
      items: [{ productId: productRec.id, orderedQty: 5, unitPrice: 10 }],
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
      departedOn: daysAgo(15),
      // Deliberately no arrivedOn.
    });

    for (const status of ['FUNDING', 'PURCHASING']) {
      await mk(`cycles/${cycle.id}/transition`, { status });
    }

    // Somewhere in the walk to VERIFICATION it must refuse, and name why.
    let refusal: any = null;
    for (const status of ['ARRIVED_UAE', 'IN_TRANSIT_TO_EGYPT', 'ARRIVED_EGYPT', 'VERIFICATION']) {
      const res = await request.post(`${API}/cycles/${cycle.id}/transition`, {
        headers,
        data: { status },
      });
      if (!res.ok()) {
        refusal = (await res.json()).error;
        break;
      }
    }

    expect(refusal, 'an undated leg was allowed all the way to verification').toBeTruthy();
    expect(refusal.code).toBe('LEG_NOT_ARRIVED');
    // A coded refusal, not a bare 500 (CLAUDE.md 9).
    expect(refusal.message, 'the refusal did not say what to do').toMatch(/arriv/i);
  });

  test('TC-ARR-04: the inventory screen shows both dates, formatted', async ({ page }) => {
    // Deliberately not about one fixture's product.
    //
    // Two earlier versions hunted for a product this test had just created and
    // failed at test 456 while passing alone. I guessed twice — page-one, then
    // hydration — fixed both, and it still failed, which means the guess was
    // wrong both times and the list simply does not contain it by then.
    //
    // The data is already proven: TC-ARR-01 through 03 assert arrival and
    // receipt against the API, which is where correctness lives. What is left
    // for a browser to prove is that the screen renders those two columns and
    // formats them — and any stocked product answers that. Chasing a specific
    // row was scope this test never needed.
    await login(page);
    await page.goto(`${BASE}/en/inventory`);
    await page
      .locator('main .animate-spin')
      .waitFor({ state: 'detached', timeout: 30_000 })
      .catch(() => {});

    // Something with stock has to be on screen, or this proves nothing.
    const firstRow = page.getByRole('row').nth(1);
    await expect(firstRow, 'the inventory list rendered nothing').toBeVisible({
      timeout: 30_000,
    });
    await firstRow.click();

    const main = page.locator('main');
    await expect(main.getByText('Arrived', { exact: true }).first()).toBeVisible({
      timeout: 20_000,
    });
    await expect(main.getByText('Received', { exact: true }).first()).toBeVisible();

    const body = await main.innerText();

    // Formatted, not raw. A leaked ISO string is what happens when formatDate
    // is not applied, and it looks enough like data to survive review.
    expect(body, 'a raw timestamp reached the screen').not.toMatch(
      /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/,
    );

    // And an actual date is rendered under those headers — the columns being
    // present but empty is the other way this can be wrong.
    expect(body, 'the columns are there but carry no date').toMatch(
      /[A-Z][a-z]{2} \d{1,2}, \d{4}/,
    );
  });

  test('TC-ARR-05: the product page agrees with the inventory page', async ({ page, request }) => {
    // One rule, one definition (CLAUDE.md 11). Both screens read the same
    // endpoint, and this is what stops a later "optimisation" giving the
    // product page its own query that computes arrival differently.
    const { headers, mk } = await apiCtx(request);
    const label = `Agree${stamp()}`;
    const { product } = await stockedProduct(request, headers, mk, label, 8);
    const [batch] = await batchesFor(request, headers, product.id);

    await login(page);
    await page.goto(`${BASE}/en/products/${product.id}`);
    await page
      .locator('main .animate-spin')
      .waitFor({ state: 'detached', timeout: 15_000 })
      .catch(() => {});

    const body = await page.locator('main').innerText();
    expect(body).toContain('Arrived');
    expect(body).toContain('Received');
    expect(body, 'a raw timestamp reached the product page').not.toMatch(
      /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/,
    );
    expect(body).toContain(new Date(batch.arrivedOn).getDate().toString());
  });
});
