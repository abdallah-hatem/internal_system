/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: Editing a saved record
 * ═══════════════════════════════════════════════════════════════════════
 *  What you typed is what got stored, and what got stored is what you see
 *  when you come back.
 *
 *  The suite had 252 tests and none of them re-opened a saved record to
 *  change it. Every UI test walked a create-once path and asserted the app
 *  moved on, which is not the same thing as asserting anything was written.
 *  Two bugs lived in that gap for as long as the wizard has existed:
 *
 *    - The shipping step returned before saving whenever the legs already
 *      existed, so every edit on a second visit was discarded — silently,
 *      behind a success step.
 *    - The date pickers had no defaultValue, so a stored date never came
 *      back onto the form.
 *
 *  Both are invisible to a test that only creates. They are caught by the
 *  shape below: save → re-open → assert it came back → change it → save →
 *  assert it persisted.
 *
 *  This suite builds its own cycle rather than searching for a usable one, so
 *  it cannot quietly skip itself when the database is empty.
 *
 *  It does NOT clean up after itself, and cannot: there is deliberately no way
 *  to delete a cycle, because financial history is never destroyed (BRD §10).
 *  So these tests depend on the suite's snapshot-and-restore — run them through
 *  the normal config, never against a database whose contents matter.
 */
import { test, expect, Page, APIRequestContext } from '@playwright/test';

const BASE = 'http://localhost:3000';
const API = 'http://localhost:3001/api/v1';
const EMAIL = 'partner.a@motoparts.com';
const PASSWORD = 'password123';

async function login(page: Page) {
  await page.goto(`${BASE}/en/login`);
  await page.getByPlaceholder('partner.a@motoparts.com').fill(EMAIL);
  await page.getByPlaceholder('••••••••').fill(PASSWORD);
  await page.getByRole('button', { name: /login/i }).click();
  await expect(page).toHaveURL(/dashboard/, { timeout: 10000 });
}

async function token(request: APIRequestContext) {
  const auth = await request.post(`${API}/auth/login`, {
    data: { email: EMAIL, password: PASSWORD },
  });
  return (await auth.json()).data.accessToken;
}

async function pickDate(page: Page, name: string, iso: string) {
  await page.locator(`[data-date-picker="${name}"]`).click();
  const grid = page.getByRole('grid');
  await grid.waitFor({ state: 'visible' });

  const targetMonth = iso.slice(0, 7);
  for (let i = 0; i < 36; i++) {
    const shown = await grid
      .locator('[data-day]:not([data-outside])')
      .first()
      .getAttribute('data-day');
    const shownMonth = (shown ?? '').slice(0, 7);
    if (shownMonth === targetMonth) break;
    await page.getByTestId(shownMonth < targetMonth ? 'calendar-next' : 'calendar-prev').click();
  }

  await grid.locator(`[data-day="${iso}"]:not([data-outside])`).click();
  await expect(page.locator(`input[type="hidden"][name="${name}"]`)).toHaveValue(iso);
}

/**
 * A UAE-direct cycle with a purchase order and one already-saved leg.
 *
 * The purchase order is not incidental: the wizard decides where to resume
 * from what the cycle already has, and a cycle with legs but no order never
 * reaches the shipping step at all — so a fixture without one tests nothing.
 * Everything is created here rather than searched for, so this cannot pass by
 * skipping itself on an empty database.
 */
async function cycleWithALeg(request: APIRequestContext) {
  const t = await token(request);
  const headers = { Authorization: `Bearer ${t}` };
  const stamp = Date.now();

  const supRes = await request.post(`${API}/suppliers`, {
    headers,
    data: { name: `Round Trip Supplier ${stamp}`, country: 'AE' },
  });
  expect(supRes.ok(), await supRes.text()).toBeTruthy();
  const supplier = (await supRes.json()).data ?? (await supRes.json());

  const prodRes = await request.post(`${API}/products`, {
    headers,
    data: { name: `Round Trip Part ${stamp}`, minStock: 0 },
  });
  expect(prodRes.ok(), await prodRes.text()).toBeTruthy();
  const product = (await prodRes.json()).data ?? (await prodRes.json());

  const created = await request.post(`${API}/cycles`, {
    headers,
    data: { originType: 'UAE_DIRECT', currency: 'AED' },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const cycle = (await created.json()).data ?? (await created.json());

  const po = await request.post(`${API}/cycles/${cycle.id}/purchases`, {
    headers,
    data: {
      supplierId: supplier.id,
      currency: 'AED',
      fxRateToEgp: 13.85,
      orderedOn: '2026-08-01',
      items: [{ productId: product.id, orderedQty: 10, unitPrice: 5 }],
    },
  });
  expect(po.ok(), await po.text()).toBeTruthy();

  const legRes = await request.post(`${API}/cycles/${cycle.id}/shipping-legs`, {
    headers,
    data: {
      sequence: 1,
      origin: 'Dubai, UAE',
      destination: 'Cairo, Egypt',
      provider: 'Round Trip Freight',
      trackingRef: 'RT-BEFORE',
      costBasis: 'FLAT',
      amount: 1000,
      currency: 'EGP',
      fxRateToEgp: 1,
    },
  });
  expect(legRes.ok(), await legRes.text()).toBeTruthy();

  return { headers, cycleId: cycle.id };
}

/**
 * Open the wizard at the shipping step.
 *
 * Where it resumes depends on how complete the cycle is, so the step is
 * selected explicitly rather than assumed.
 */
async function openShippingStep(page: Page, cycleId: string) {
  await page.goto(`${BASE}/en/cycles/${cycleId}`);
  await page.getByText('Shipping Leg', { exact: true }).click();
  await expect(page.locator('input[name="leg1_origin"]')).toBeVisible({ timeout: 15000 });
}

async function legFromApi(request: APIRequestContext, headers: any, cycleId: string) {
  const res = await request.get(`${API}/cycles/${cycleId}/shipping-legs`, { headers });
  const body = await res.json();
  return (body.data ?? body)[0];
}

test.describe('Editing a saved record round-trips', () => {
  test('TC-RT-01: a saved leg shows its stored values when the wizard is re-opened', async ({
    page,
    request,
  }) => {
    const { headers, cycleId } = await cycleWithALeg(request);

    await login(page);
    await openShippingStep(page, cycleId);

    // The stored values must be on the form, not blank defaults.
    await expect(page.locator('input[name="leg1_origin"]')).toHaveValue('Dubai, UAE');
    await expect(page.locator('input[name="leg1_destination"]')).toHaveValue('Cairo, Egypt');
    await expect(page.locator('input[name="leg1_trackingRef"]')).toHaveValue('RT-BEFORE');

    // Nothing was stored for the dates, so they must be genuinely empty —
    // not showing a stale or invented value.
    await expect(
      page.locator('input[type="hidden"][name="leg1_departedOn"]'),
    ).toHaveValue('');
  });

  test('TC-RT-02: editing a saved leg persists — it is not silently discarded', async ({
    page,
    request,
  }) => {
    const { headers, cycleId } = await cycleWithALeg(request);

    await login(page);
    await openShippingStep(page, cycleId);
    await expect(page.locator('input[name="leg1_trackingRef"]')).toHaveValue('RT-BEFORE');

    // Change a date and a text field, then save.
    await pickDate(page, 'leg1_departedOn', '2026-08-11');
    await pickDate(page, 'leg1_arrivedOn', '2026-08-19');
    await page.locator('input[name="leg1_trackingRef"]').fill('RT-AFTER');
    await page.getByRole('button', { name: /save & continue/i }).click();

    // The assertion the suite never made anywhere: what the API now holds.
    // Without it the old code passed — it advanced a step and wrote nothing.
    await expect
      .poll(async () => (await legFromApi(request, headers, cycleId)).trackingRef, {
        timeout: 10000,
      })
      .toBe('RT-AFTER');

    const leg = await legFromApi(request, headers, cycleId);
    expect(leg.departedOn?.slice(0, 10)).toBe('2026-08-11');
    expect(leg.arrivedOn?.slice(0, 10)).toBe('2026-08-19');
  });

  test('TC-RT-03: the saved dates come back onto the form after a reload', async ({
    page,
    request,
  }) => {
    const { headers, cycleId } = await cycleWithALeg(request);

    await login(page);
    await openShippingStep(page, cycleId);
    await pickDate(page, 'leg1_departedOn', '2026-08-11');
    await page.getByRole('button', { name: /save & continue/i }).click();

    await expect
      .poll(
        async () =>
          (await legFromApi(request, headers, cycleId)).departedOn?.slice(0, 10),
        { timeout: 10000 },
      )
      .toBe('2026-08-11');

    // Come back to it the way the owner did: fresh load, same cycle.
    await openShippingStep(page, cycleId);
    await expect(
      page.locator('input[type="hidden"][name="leg1_departedOn"]'),
    ).toHaveValue('2026-08-11');
  });

  test('TC-RT-04: an edit to origin or destination is accepted, not dropped', async ({
    page,
    request,
  }) => {
    const { headers, cycleId } = await cycleWithALeg(request);

    await login(page);
    await openShippingStep(page, cycleId);
    await page.locator('input[name="leg1_origin"]').fill('Sharjah, UAE');
    await page.getByRole('button', { name: /save & continue/i }).click();

    // These two were missing from the update endpoint entirely, so the change
    // reached the server and was thrown away by validation stripping.
    await expect
      .poll(async () => (await legFromApi(request, headers, cycleId)).origin, {
        timeout: 10000,
      })
      .toBe('Sharjah, UAE');
  });
});

/**
 * A cycle in AED with no purchase order yet, so the purchase order step opens
 * with the currency already chosen and the rate still to be filled.
 */
async function cycleAwaitingItsOrder(request: APIRequestContext, currency = 'AED') {
  const t = await token(request);
  const headers = { Authorization: `Bearer ${t}` };
  const created = await request.post(`${API}/cycles`, {
    headers,
    data: { originType: 'UAE_DIRECT', currency },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  return { headers, cycleId: ((await created.json()).data ?? {}).id };
}

test.describe('FX rates reach the forms', () => {
  test('TC-RT-05: choosing a currency fills in its stored rate', async ({ page, request }) => {
    const t = await token(request);
    const headers = { Authorization: `Bearer ${t}` };

    const res = await request.get(`${API}/currency-rates/map`, { headers });
    const rates = (await res.json()).data;
    expect(rates.AED, 'AED must have a rate for this test to mean anything').toBeTruthy();

    await login(page);
    await page.goto(`${BASE}/en/ledger`);
    await page.getByRole('button', { name: /new entry/i }).click();

    const trigger = page
      .locator('input[type="hidden"][name="currency"]')
      .locator('..')
      .getByRole('combobox');
    await trigger.click();
    await page.getByRole('listbox').getByRole('option').filter({ hasText: 'AED' }).first().click();

    await expect(page.locator('input[name="fxRateToEgp"]')).toHaveValue(String(rates.AED));
  });

  test('TC-RT-06: a currency that is ALREADY selected gets its rate too', async ({
    page,
    request,
  }) => {
    // The case the first pass missed: the rate was only filled by the act of
    // changing the currency, so a form that opened already set to AED sat
    // there with an empty rate and no hint that one was known.
    const { headers, cycleId } = await cycleAwaitingItsOrder(request, 'AED');

    const rates = (await (await request.get(`${API}/currency-rates/map`, { headers })).json()).data;
    expect(rates.AED).toBeTruthy();

    await login(page);
    await page.goto(`${BASE}/en/cycles/${cycleId}`);

    // Nothing is touched — the currency arrives selected from the cycle.
    const currency = page
      .locator('input[type="hidden"][name="currency"]')
      .locator('..')
      .getByRole('combobox');
    await expect(currency).toContainText('AED');
    await expect(page.locator('input[name="fxRateToEgp"]')).toHaveValue(
      Number(rates.AED).toFixed(4),
    );
  });

  test('TC-RT-07: a leg saved in a foreign currency shows its stored rate on reload', async ({
    page,
    request,
  }) => {
    // The rate on a saved leg is the one the shipment was actually paid at, so
    // reopening must show that and not today's. (An earlier version of this
    // test claimed to catch a leg being costed 1:1 for want of a rate — that
    // cannot happen: fx_rate_to_egp is NOT NULL and defaults to 1, so a stored
    // leg always carries a rate. What is worth guarding is the round-trip.)
    const { headers, cycleId } = await cycleWithALeg(request);

    const legs = await request.get(`${API}/cycles/${cycleId}/shipping-legs`, { headers });
    const leg = ((await legs.json()).data ?? [])[0];

    // Agreed at 13.50, deliberately not the 13.85 the rates table holds.
    const agreed = 13.5;
    const put = await request.put(`${API}/shipping/legs/${leg.id}`, {
      headers,
      data: { currency: 'AED', fxRateToEgp: agreed, costBasis: 'FLAT', amount: 1000 },
    });
    expect(put.ok(), await put.text()).toBeTruthy();

    await login(page);
    await openShippingStep(page, cycleId);

    const fx = page.locator('input[name="leg1_fxRateToEgp"]');
    await expect(fx).toHaveValue(String(agreed));

    const rates = (await (await request.get(`${API}/currency-rates/map`, { headers })).json()).data;
    // Today's rate must not have overwritten what was agreed.
    await expect(fx).not.toHaveValue(String(rates.AED));
  });

  test('TC-RT-08: a cycle whose stock is already in does not dead-end on step 4', async ({
    page,
    request,
  }) => {
    // Going back to ARRIVED_EGYPT is the only way into the wizard to correct a
    // shipping leg, so the list offers "Resume" — but stock can only be
    // received once, and pressing Complete used to fail at the last click with
    // "Stock already verified". Step 4 now says what is already in and
    // finishes the cycle instead of refusing.
    const { headers, cycleId } = await cycleWithALeg(request);

    // The shipment has to have actually arrived before the cycle can pass it,
    // so the dates go on first. The fixture leaves them empty on purpose —
    // TC-RT-01 checks a leg with no dates comes back with none.
    const legs = await (await request.get(`${API}/cycles/${cycleId}/shipping-legs`, { headers })).json();
    const daysBack = (n: number) => {
      const d = new Date();
      d.setDate(d.getDate() - n);
      return d.toISOString().slice(0, 10);
    };
    await request.put(`${API}/shipping/legs/${(legs.data ?? legs)[0].id}`, {
      headers, data: { departedOn: daysBack(20), arrivedOn: daysBack(5) },
    });

    // Walk it through to VERIFICATION and receive the stock.
    for (const status of ['FUNDING', 'PURCHASING', 'ARRIVED_UAE', 'IN_TRANSIT_TO_EGYPT', 'ARRIVED_EGYPT', 'VERIFICATION']) {
      const res = await request.post(`${API}/cycles/${cycleId}/transition`, {
        headers, data: { status },
      });
      expect(res.ok(), `${status}: ${await res.text()}`).toBeTruthy();
    }

    const cyc = await (await request.get(`${API}/cycles/${cycleId}`, { headers })).json();
    const code = (cyc.data ?? cyc).code;
    const poItem = (cyc.data ?? cyc).purchaseOrders[0].items[0];
    const verified = await request.post(`${API}/receipts/verify`, {
      headers,
      data: {
        cycleId,
        items: [{
          purchaseOrderItemId: poItem.id,
          productId: poItem.productId,
          receivedQty: Number(poItem.orderedQty),
        }],
      },
    });
    expect(verified.ok(), await verified.text()).toBeTruthy();

    // Back a step, the way someone does to fix a shipping cost.
    const back = await request.post(`${API}/cycles/${cycleId}/transition`, {
      headers, data: { status: 'ARRIVED_EGYPT' },
    });
    expect(back.ok(), await back.text()).toBeTruthy();

    await login(page);

    // Reach the cycle the way a person does: from the list, by clicking. Both
    // halves matter. Visiting the list first is what puts it in the cache, and
    // CLICKING through keeps that cache alive — page.goto() is a full load that
    // wipes it, so a test that navigates by URL can never see a stale list no
    // matter what the code does.
    await page.goto(`${BASE}/en/cycles`);
    const listRow = page.locator('tr', { hasText: code });
    await expect(listRow).toContainText(/arrived/i, { timeout: 15000 });
    await expect(listRow).toContainText(/resume/i);
    await listRow.click();
    await expect(page).toHaveURL(new RegExp(cycleId), { timeout: 15000 });

    // Step 4 states what is already in stock rather than offering it again.
    await expect(page.getByText(/already received into stock/i)).toBeVisible({ timeout: 15000 });
    const done = page.getByRole('button', { name: /^done$/i });
    await expect(done).toBeVisible();
    await done.click();

    // It finishes and lands back on the list — and the list must SHOW the new
    // state. Asserting the API alone passed while the page still displayed the
    // old status from cache, which is what the owner actually hit: saved,
    // navigated, and no visible change until a manual refresh.
    await expect(page).toHaveURL(/\/cycles$/, { timeout: 15000 });

    const row = page.locator('tr', { hasText: code });
    await expect(row).toContainText(/verification/i, { timeout: 15000 });
    await expect(row).not.toContainText(/resume/i);

    // The server agrees, and no second batch was created for the same item.
    const after = await (await request.get(`${API}/cycles/${cycleId}`, { headers })).json();
    expect((after.data ?? after).status).toBe('VERIFICATION');
    expect((after.data ?? after).inventoryBatches).toHaveLength(1);
  });
});
