/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: I3 — the cycle details page moves the shipment on
 * ═══════════════════════════════════════════════════════════════════════
 *  1. A leg's departure and its deliveries are recorded from the Shipping
 *     card on the cycle's page (owner, 2026-10-11).
 *  2. A status change refused because a leg has not left or not arrived
 *     offers that fix in place, then the move is retried in the same dialog.
 *  3. Where-the-goods-are cards at the top of the page (layout A).
 *
 *  Every flow reaches the page through the menu and the cycles list, the way
 *  a person does (CLAUDE.md §2); cycles are built through the API as a
 *  partner (§4). Unit tests for the same rules:
 *  src/components/cycles/{cycle-leg-actions,cycle-status-fix,goods-location*}.test.ts(x)
 *  and apps/api/src/modules/shipping/deliveries.service.spec.ts.
 *
 *  `I3_SHOTS=1` also writes the review screenshots to .ui-audit/i3/.
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { aCorePartnerUser, API, apiCtx, daysAgo, investorSession } from './support/fixtures';
import { login, messages, type Locale } from './support/ui';
import { WEB } from './support/env';

const SHOTS = process.env.I3_SHOTS === '1';
const SHOT_DIR = '../../.ui-audit/i3';

type Headers = Record<string, string>;

/**
 * A cycle with two products ordered (40 pads, 10 chains), its legs recorded
 * and none departed unless asked. A fresh investor is on it (fixtures
 * `investorSession`); `investor` is the token they would hold.
 */
async function cycleWithLegs(
  request: APIRequestContext,
  route: 'CHINA' | 'UAE_DIRECT',
  opts: { departed?: number[]; status?: string[] } = {},
) {
  const { headers, mk } = await apiCtx(request);
  const investorSide = await investorSession(request, 'i3');
  const investorId = investorSide.user.id;
  const partner = await aCorePartnerUser(request, headers);
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const pad = await mk('products', { name: `I3 ${stamp} Brake pad`, minStock: 0 });
  const chain = await mk('products', { name: `I3 ${stamp} Chain kit`, minStock: 0 });
  const supplier = await mk('suppliers', { name: `I3 ${stamp} Supplier`, country: 'CN' });
  const cycle = await mk('cycles', {
    originType: route,
    currency: 'EGP',
    participants: [
      { participantType: 'TEMP_INVESTOR', investorUserId: investorId, contributionAmount: 400, investorFeePct: 10 },
      { participantType: 'CORE_PARTNER', partnerUserId: partner.id, contributionAmount: 600 },
    ],
  });
  await mk(`cycles/${cycle.id}/purchases`, {
    supplierId: supplier.id, currency: 'EGP', fxRateToEgp: 1, orderedOn: daysAgo(25),
    items: [
      { productId: pad.id, orderedQty: 40, unitPrice: 100 },
      { productId: chain.id, orderedQty: 10, unitPrice: 50 },
    ],
  });
  const route2 =
    route === 'CHINA'
      ? [['Guangzhou, CN', 'Dubai, UAE'], ['Dubai, UAE', 'Cairo, Egypt']]
      : [['Dubai, UAE', 'Cairo, Egypt']];
  const legs = [];
  for (let i = 0; i < route2.length; i++) {
    legs.push(
      await mk(`cycles/${cycle.id}/shipping-legs`, {
        sequence: i + 1, origin: route2[i][0], destination: route2[i][1],
        costBasis: 'FLAT', amount: 0, currency: 'EGP', fxRateToEgp: 1,
        ...(opts.departed?.includes(i + 1) ? { departedOn: daysAgo(20 - i * 10) } : {}),
      }),
    );
  }
  for (const status of opts.status ?? []) await mk(`cycles/${cycle.id}/transition`, { status });
  const full = await (await request.get(`${API}/cycles/${cycle.id}`, { headers })).json();
  const items = (full.data ?? full).purchaseOrders[0].items as Array<{ id: string; productId: string }>;
  const padItem = items.find((x) => x.productId === pad.id)!;
  const chainItem = items.find((x) => x.productId === chain.id)!;
  return { headers, mk, cycle, legs, pad, chain, padItem, chainItem, investor: investorSide.headers };
}

/** Menu → Cycles → search the code → the row → its details page. */
async function openCycle(page: Page, code: string, id: string, locale: Locale = 'en') {
  await page.locator(`aside a[href="/${locale}/cycles"]`).filter({ visible: true }).first().click();
  await expect(page).toHaveURL(new RegExp(`/${locale}/cycles$`), { timeout: 15000 });
  const main = page.getByRole('main');
  await main.getByPlaceholder(messages(locale).cycles.search).fill(code);
  await main.getByTestId('cycle-row').filter({ hasText: code }).locator('td').first().click();
  await expect(page).toHaveURL(new RegExp(`/cycles/${id}/details$`), { timeout: 15000 });
  await expect(page.getByTestId('cycle-status')).toBeVisible();
}

/** Same, on a phone: the list shows cards and the menu sits behind a button. */
async function openCyclePhone(page: Page, code: string, id: string, locale: Locale = 'en') {
  await page.locator('button:has(svg.icon-menu)').filter({ visible: true }).first().click();
  await page.locator(`a[href="/${locale}/cycles"]`).filter({ visible: true }).first().click();
  await expect(page).toHaveURL(new RegExp(`/${locale}/cycles$`), { timeout: 15000 });
  const main = page.getByRole('main');
  await main.getByPlaceholder(messages(locale).cycles.search).fill(code);
  await main.getByTestId('cycle-card').filter({ hasText: code }).first().click();
  await expect(page).toHaveURL(new RegExp(`/cycles/${id}/details$`), { timeout: 15000 });
  await expect(page.getByTestId('cycle-status')).toBeVisible();
}

const leg = (page: Page, legId: string) => page.locator(`[data-testid="shipment-leg"][data-leg-id="${legId}"]`);
const dialog = (page: Page, kind: string) => page.locator(`[data-shipment-dialog="${kind}"]`);

/** The cycle totals the location cards show, place → figure. */
async function cards(page: Page) {
  const section = page.getByTestId('goods-location');
  await expect(section).toBeVisible();
  const out: Record<string, string> = {};
  for (const c of await section.getByTestId('location-card').all()) {
    out[(await c.getAttribute('data-place'))!] = (await c.getByTestId('location-value').innerText()).trim();
  }
  return out;
}

async function statusOf(request: APIRequestContext, headers: Headers, id: string) {
  const r = await (await request.get(`${API}/cycles/${id}`, { headers })).json();
  return (r.data ?? r).status as string;
}

const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: `${SHOT_DIR}/${name}.png`, fullPage: true });
};

const en = messages('en');

// ─── 1. Departure and delivery from the Shipping card ───────────────────

test.describe('A leg leaves and arrives from the cycle page', () => {
  test('TC-I3-01: a partner records leg 1’s departure, then a partial delivery — the leg, the cards and the shipment all follow', async ({ page, request }) => {
    const { headers, cycle, legs } = await cycleWithLegs(request, 'CHINA');
    await login(page);
    await openCycle(page, cycle.code, cycle.id);

    expect(await cards(page)).toEqual({ inChina: '50', toUae: '0', inUae: '0', toEgypt: '0', inEgypt: '0', sold: '0' });
    // One place for the legs: each listed once, in the Shipment panel, and no
    // second Shipping card repeating them with its own Record delivery.
    await expect(page.getByTestId('shipment-leg')).toHaveCount(2);
    await expect(page.getByTestId('shipping-card')).toHaveCount(0);
    // Only leg 1 has goods waiting to leave: nothing has reached Dubai for
    // leg 2 yet (L8), so it offers no departure.
    await expect(page.getByTestId('record-departure')).toHaveCount(1);
    await expect(leg(page, legs[0].id).getByTestId('record-departure')).toHaveCount(1);
    // Not departed: departure offered, delivery not.
    await expect(leg(page, legs[0].id).getByTestId('record-delivery')).toHaveCount(0);
    await leg(page, legs[0].id).getByTestId('record-departure').click();
    await expect(dialog(page, 'record-departure')).toBeVisible();
    await dialog(page, 'record-departure').getByRole('button', { name: en.shipment.recordDeparture, exact: true }).click();
    await expect(dialog(page, 'record-departure')).toHaveCount(0);
    await expect(page.getByText(en.shipment.departureRecorded)).toBeVisible();

    // The leg reads in transit and now offers a delivery; the cards moved without a reload.
    await expect(leg(page, legs[0].id).getByTestId('leg-status')).toHaveText(en.codes.legStatus.IN_TRANSIT);
    await expect(leg(page, legs[0].id).getByTestId('record-departure')).toHaveCount(0);
    // Exactly one Record delivery on the whole page: leg 1's, in its header.
    await expect(page.getByTestId('record-delivery')).toHaveCount(1);
    await expect(leg(page, legs[0].id).getByTestId('record-delivery')).toHaveCount(1);
    await expect.poll(() => cards(page)).toEqual({ inChina: '0', toUae: '50', inUae: '0', toEgypt: '0', inEgypt: '0', sold: '0' });

    await leg(page, legs[0].id).getByTestId('record-delivery').click();
    const d = dialog(page, 'record-delivery');
    const pads = d.getByTestId('delivery-qty').first();
    await expect(pads).toHaveValue('40');
    await pads.fill('15');
    // Chains: nothing arrived yet.
    await d.getByTestId('delivery-qty').nth(1).fill('0');
    await d.getByRole('button', { name: en.shipment.recordDelivery, exact: true }).click();
    await expect(d).toHaveCount(0);

    await expect(leg(page, legs[0].id).getByTestId('leg-status')).toHaveText(en.codes.legStatus.PARTLY_ARRIVED);
    await expect.poll(() => cards(page)).toEqual({ inChina: '0', toUae: '35', inUae: '15', toEgypt: '0', inEgypt: '0', sold: '0' });
    // Per product, too.
    const padRow = page.getByTestId('location-row').filter({ hasText: 'Brake pad' });
    await expect(padRow.locator('[data-place="inUae"]')).toHaveText('15');
    await expect(padRow.locator('[data-place="toUae"]')).toHaveText('25');

    // The server agrees: one departure, one delivery of 15.
    const s = await (await request.get(`${API}/cycles/${cycle.id}/shipment`, { headers })).json();
    const leg1 = (s.data ?? s).legs[0];
    expect(leg1.departedOn).toBeTruthy();
    expect(leg1.deliveries).toHaveLength(1);
    expect(leg1.delivered).toBe(15);
  });

  // TC-I3-02's screen half (the investor reads the cards and legs, offered neither action) removed
  // (owner 2026-10-19): only the partners use the office; investors are refused at the door.
  test('TC-I3-02: the API refuses an investor on the cycle a departure', async ({ request }) => {
    const { legs, investor } = await cycleWithLegs(request, 'CHINA', { departed: [1] });
    const r = await request.put(`${API}/shipping/legs/${legs[1].id}`, { headers: investor, data: { departedOn: daysAgo(1) } });
    expect(r.status()).toBe(403);
    expect((await r.json()).error?.code).toBe('ROLE_NOT_ALLOWED');
  });

  test('TC-I3-03: a cancelled cycle offers neither action, and the server refuses a departure there; the same date re-sent is not a change', async ({ page, request }) => {
    const { headers, cycle, legs } = await cycleWithLegs(request, 'UAE_DIRECT', { status: ['CANCELLED'] });
    await login(page);
    await openCycle(page, cycle.code, cycle.id);
    await expect(page.getByTestId('shipment-leg')).toHaveCount(1);
    await expect(page.getByTestId('record-departure')).toHaveCount(0);
    await expect(page.getByTestId('record-delivery')).toHaveCount(0);

    const r = await request.put(`${API}/shipping/legs/${legs[0].id}`, { headers, data: { departedOn: daysAgo(1) } });
    expect(r.status()).toBe(400);
    expect((await r.json()).error?.code).toBe('CYCLE_CLOSED');
    const after = await (await request.get(`${API}/cycles/${cycle.id}`, { headers })).json();
    expect((after.data ?? after).shippingLegs[0].departedOn).toBeNull();
  });

  test('TC-I3-04: a departure dated tomorrow is refused by the server; the dialog’s own date cannot go past today', async ({ request }) => {
    const { headers, legs } = await cycleWithLegs(request, 'UAE_DIRECT');
    const t = new Date();
    t.setDate(t.getDate() + 2);
    const r = await request.put(`${API}/shipping/legs/${legs[0].id}`, { headers, data: { departedOn: t.toISOString().slice(0, 10) } });
    expect(r.status()).toBe(400);
    expect((await r.json()).error?.code).toBe('DATE_IN_FUTURE');
  });
});

// ─── 2. A refused status change offers its fix ──────────────────────────

test.describe('Change status offers the fix for the leg it names', () => {
  // L3 (§1, 2026-10-11): the departure recorded from the refusal moves the
  // cycle on by itself, so there is nothing left to try again.
  test('TC-I3-05: Purchasing → In transit refused (leg 1 not departed): record the departure from the refusal — the cycle moves by itself', async ({ page, request }) => {
    const { headers, cycle, legs } = await cycleWithLegs(request, 'CHINA', { status: ['FUNDING', 'PURCHASING'] });
    await login(page);
    await openCycle(page, cycle.code, cycle.id);

    await page.getByTestId('change-status').click();
    const status = page.getByTestId('change-status-dialog');
    await status.locator('[data-status="IN_TRANSIT"]').click();
    const refusal = status.getByTestId('status-refusal');
    await expect(refusal).toContainText('has not departed yet');
    await expect(page.getByText(en.cycles.statusUpdated)).toHaveCount(0);
    await shot(page, 'status-refusal-fix-departed-en');

    await refusal.getByTestId('status-fix').click();
    await expect(status).toBeHidden();
    const dep = dialog(page, 'record-departure');
    await expect(dep).toContainText(en.shipment.recordDepartureTitle.replace('{leg}', '1'));
    await dep.getByRole('button', { name: en.shipment.recordDeparture, exact: true }).click();

    await expect(page.getByText(`${en.shipment.departureRecorded} — cycle is now ${en.codes.cycleStatus.IN_TRANSIT}`)).toBeVisible();
    await expect(dep).toHaveCount(0);
    await expect(status).toBeHidden();
    await expect(page.getByTestId('cycle-status')).toHaveText(en.codes.cycleStatus.IN_TRANSIT);
    expect(await statusOf(request, headers, cycle.id)).toBe('IN_TRANSIT');
    await expect(leg(page, legs[0].id).getByTestId('leg-status')).toHaveText(en.codes.legStatus.IN_TRANSIT);
  });

  test('TC-I3-06: In transit → Arrived UAE refused (nothing delivered): cancel the fix, the refusal is still there; record the delivery — the cycle moves by itself', async ({ page, request }) => {
    const { headers, cycle, legs } = await cycleWithLegs(request, 'CHINA', { departed: [1], status: ['FUNDING', 'PURCHASING', 'IN_TRANSIT'] });
    await login(page);
    await openCycle(page, cycle.code, cycle.id);

    await page.getByTestId('change-status').click();
    const status = page.getByTestId('change-status-dialog');
    await status.locator('[data-status="ARRIVED_UAE"]').click();
    const fix = status.getByTestId('status-fix');
    await expect(fix).toHaveText(en.shipment.recordDelivery);
    await shot(page, 'status-refusal-fix-arrived-en');

    // Cancel the fix: back to the refusal, nothing recorded.
    await fix.click();
    const del = dialog(page, 'record-delivery');
    await expect(del).toContainText(en.shipment.recordDeliveryTitle.replace('{leg}', '1'));
    await del.getByRole('button', { name: en.common.cancel, exact: true }).click();
    await expect(status.getByTestId('status-refusal')).toBeVisible();

    await status.getByTestId('status-fix').click();
    await expect(del.getByTestId('delivery-qty').first()).toHaveValue('40');
    await del.getByRole('button', { name: en.shipment.recordDelivery, exact: true }).click();
    await expect(page.getByText(`${en.shipment.deliveryRecorded} — cycle is now ${en.codes.cycleStatus.ARRIVED_UAE}`)).toBeVisible();
    await expect(status).toBeHidden();
    await expect(page.getByTestId('cycle-status')).toHaveText(en.codes.cycleStatus.ARRIVED_UAE);
    expect(await statusOf(request, headers, cycle.id)).toBe('ARRIVED_UAE');
    // All of it reached Dubai; leg 2 has not left.
    await expect.poll(() => cards(page)).toEqual({ inChina: '0', toUae: '0', inUae: '50', toEgypt: '0', inEgypt: '0', sold: '0' });
    expect(legs).toHaveLength(2);
  });

  test('TC-I3-07: closing the status dialog clears it — reopening shows the choices with no old refusal', async ({ page, request }) => {
    const { cycle } = await cycleWithLegs(request, 'CHINA', { status: ['FUNDING', 'PURCHASING'] });
    await login(page);
    await openCycle(page, cycle.code, cycle.id);
    await page.getByTestId('change-status').click();
    const status = page.getByTestId('change-status-dialog');
    await status.locator('[data-status="IN_TRANSIT"]').click();
    await expect(status.getByTestId('status-refusal')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(status).toBeHidden();
    await page.getByTestId('change-status').click();
    await expect(status.locator('[data-status="IN_TRANSIT"]')).toBeVisible();
    await expect(status.getByTestId('status-refusal')).toHaveCount(0);
  });

  test('TC-I3-08: the refusal names the leg by id and by route — the id is what the fix opens', async ({ request }) => {
    const { headers, cycle, legs } = await cycleWithLegs(request, 'CHINA', { status: ['FUNDING', 'PURCHASING'] });
    const r = await request.post(`${API}/cycles/${cycle.id}/transition`, { headers, data: { status: 'IN_TRANSIT' } });
    const err = (await r.json()).error;
    expect(err.code).toBe('LEG_NOT_DEPARTED');
    expect(err.params).toEqual({ leg: 'Guangzhou, CN → Dubai, UAE', legId: legs[0].id });
  });
});

// ─── 3. Where the goods are ─────────────────────────────────────────────

test.describe('Where the goods are', () => {
  test('TC-I3-09: a UAE-direct cycle has no China or To-UAE cards; departing moves everything on the way to Egypt', async ({ page, request }) => {
    const { cycle, legs } = await cycleWithLegs(request, 'UAE_DIRECT');
    await login(page);
    await openCycle(page, cycle.code, cycle.id);
    expect(await cards(page)).toEqual({ inUae: '50', toEgypt: '0', inEgypt: '0', sold: '0' });
    await leg(page, legs[0].id).getByTestId('record-departure').click();
    await dialog(page, 'record-departure').getByRole('button', { name: en.shipment.recordDeparture, exact: true }).click();
    await expect.poll(() => cards(page)).toEqual({ inUae: '0', toEgypt: '50', inEgypt: '0', sold: '0' });
  });

  test('TC-I3-10: delivered to Egypt, partly checked in, partly sold, some lost — Lost appears, In Egypt names what waits, every product adds up', async ({ page, request }) => {
    const { headers, mk, cycle, legs, padItem, chainItem } = await cycleWithLegs(request, 'UAE_DIRECT', {
      departed: [1], status: ['FUNDING', 'PURCHASING', 'ARRIVED_UAE', 'IN_TRANSIT_TO_EGYPT'],
    });
    const delivery = await mk(`shipping/legs/${legs[0].id}/deliveries`, {
      arrivedOn: daysAgo(5),
      lines: [{ purchaseOrderItemId: padItem.id, qty: 30 }, { purchaseOrderItemId: chainItem.id, qty: 10 }],
    });
    await mk(`shipping/legs/${legs[0].id}/losses`, { lines: [{ purchaseOrderItemId: padItem.id, qty: 4 }] });
    await mk(`cycles/${cycle.id}/transition`, { status: 'ARRIVED_EGYPT' });
    const padLine = delivery.lines.find((l: { id: string; purchaseOrderItemId: string }) => l.purchaseOrderItemId === padItem.id);
    const chainLine = delivery.lines.find((l: { id: string; purchaseOrderItemId: string }) => l.purchaseOrderItemId === chainItem.id);
    await mk('receipts/verify', { cycleId: cycle.id, deliveryId: delivery.id, items: [{ deliveryLineId: padLine.id, receivedQty: 25 }, { deliveryLineId: chainLine.id, receivedQty: 10 }] });
    // Sell 6 pads from this cycle's batch.
    const shop = await mk('customers', { displayName: `I3 Shop ${Date.now()}`, type: 'B2B' });
    const full = await (await request.get(`${API}/cycles/${cycle.id}`, { headers })).json();
    const padProductId = (full.data ?? full).inventoryBatches.find((b: { receivedQty: string }) => Number(b.receivedQty) === 25).productId;
    await mk('sales/orders', {
      customerId: shop.id, channel: 'B2B', currency: 'EGP', confirm: true,
      items: [{ productId: padProductId, quantity: 6, unitPrice: 200, discount: 0 }],
    });

    await login(page);
    await openCycle(page, cycle.code, cycle.id);
    // Pads: 40 = 6 on the way + 4 lost + 30 delivered (25 in: 6 sold, 19 left; 5 waiting). Chains: 10 in.
    expect(await cards(page)).toEqual({ inUae: '0', toEgypt: '6', inEgypt: '34', sold: '6', lost: '4' });
    await expect(page.getByTestId('location-not-checked-in')).toHaveText('5 not checked in yet');
    const padRow = page.getByTestId('location-row').filter({ hasText: 'Brake pad' });
    for (const [place, v] of [['ordered', '40'], ['toEgypt', '6'], ['inEgypt', '24'], ['sold', '6'], ['lost', '4']]) {
      await expect(padRow.locator(`[data-place="${place}"]`)).toContainText(v);
    }
    // The app's main column scrolls on its own, so a tall window shows the whole page.
    await page.setViewportSize({ width: 1440, height: 2400 });
    await shot(page, 'cycle-details-cards-lost-en');
  });

  test('TC-I3-11: on a phone each product is its own card and the table is hidden; nothing overflows sideways', async ({ page, request }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    const { cycle } = await cycleWithLegs(request, 'CHINA', { departed: [1] });
    await login(page);
    await openCyclePhone(page, cycle.code, cycle.id);
    await expect(page.getByTestId('goods-location')).toBeVisible();
    await expect(page.getByTestId('location-table')).toBeHidden();
    await expect(page.getByTestId('location-product-card')).toHaveCount(2);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test.describe('The place cards on a phone (owner, 2026-10-20)', () => {
  for (const locale of ['en', 'ar'] as const) {
    test(`TC-I3-12 (${locale}): every card shows its icon, and each row's labels and numbers sit level`, async ({ page, request }) => {
      await page.setViewportSize({ width: 375, height: 812 });
      const { cycle } = await cycleWithLegs(request, 'CHINA', { departed: [1] });
      await login(page, locale);
      // A layout check, not a cache one: the page is opened by its address
      // (the menu's way there is TC-I3-11's).
      await page.goto(`${WEB}/${locale}/cycles/${cycle.id}/details`);
      const cardsOnPage = page.getByTestId('goods-location').getByTestId('location-card');
      await expect(cardsOnPage.first()).toBeVisible();
      const all = await cardsOnPage.all();
      expect(all.length).toBeGreaterThanOrEqual(4);
      const boxes = [];
      for (const c of all) {
        const badge = c.getByTestId('location-badge');
        await expect(badge).toBeVisible();
        const [card, icon, label, value] = await Promise.all([
          c.boundingBox(),
          badge.boundingBox(),
          c.locator('p').first().boundingBox(),
          c.getByTestId('location-value').boundingBox(),
        ]);
        boxes.push({ card: card!, icon: icon!, label: label!, value: value! });
      }
      // Two to a row on a phone: in each row the icons, the labels and the
      // numbers start at the same height, and the cards are as tall.
      for (let i = 0; i + 1 < boxes.length; i += 2) {
        const [a, b] = [boxes[i], boxes[i + 1]];
        expect(Math.abs(a.card.y - b.card.y), `row ${i / 2}`).toBeLessThanOrEqual(1);
        for (const part of ['icon', 'label', 'value'] as const) {
          expect(Math.abs(a[part].y - b[part].y), `row ${i / 2} ${part}`).toBeLessThanOrEqual(1);
        }
        expect(Math.abs(a.card.height - b.card.height), `row ${i / 2} height`).toBeLessThanOrEqual(1);
      }
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    });
  }
});

// ─── Screenshots for review (I3_SHOTS=1) ────────────────────────────────

test.describe('I3 review screenshots', () => {
  test.skip(!SHOTS, 'screenshots only on request');

  for (const locale of ['en', 'ar'] as const) {
    test(`TC-I3-SHOT (${locale}): the cards, the shipping card actions, both dialogs, the refusal fix — desktop and phone`, async ({ page, request }) => {
      const m = messages(locale);
      const { mk, cycle, legs, padItem, chainItem } = await cycleWithLegs(request, 'CHINA', {
        departed: [1], status: ['FUNDING', 'PURCHASING', 'IN_TRANSIT'],
      });
      await mk(`shipping/legs/${legs[0].id}/deliveries`, {
        arrivedOn: daysAgo(8),
        lines: [{ purchaseOrderItemId: padItem.id, qty: 30 }, { purchaseOrderItemId: chainItem.id, qty: 10 }],
      });
      await mk(`cycles/${cycle.id}/transition`, { status: 'ARRIVED_UAE' });
      await page.setViewportSize({ width: 1440, height: 900 });
      await login(page, locale);
      await openCycle(page, cycle.code, cycle.id, locale);
      await expect(page.getByTestId('goods-location')).toBeVisible();
      // The app's main column scrolls on its own, so a tall window shows the whole page.
      await page.setViewportSize({ width: 1440, height: 2600 });
      await page.screenshot({ path: `${SHOT_DIR}/cycle-details-cards-${locale}.png` });
      await page.setViewportSize({ width: 1024, height: 1400 });
      await page.screenshot({ path: `${SHOT_DIR}/cycle-details-cards-${locale}-1024.png` });
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.getByTestId('shipment-panel').scrollIntoViewIfNeeded();
      await page.getByTestId('shipment-panel').screenshot({ path: `${SHOT_DIR}/shipment-leg-actions-${locale}.png` });

      await leg(page, legs[1].id).getByTestId('record-departure').click();
      await expect(dialog(page, 'record-departure')).toBeVisible();
      await page.screenshot({ path: `${SHOT_DIR}/record-departure-dialog-${locale}.png` });
      await page.keyboard.press('Escape');

      await page.getByTestId('change-status').click();
      const status = page.getByTestId('change-status-dialog');
      await status.locator('[data-status="IN_TRANSIT_TO_EGYPT"]').click();
      await expect(status.getByTestId('status-fix')).toBeVisible();
      await page.screenshot({ path: `${SHOT_DIR}/status-refusal-fix-departed-${locale}.png` });
      await status.getByTestId('status-fix').click();
      await dialog(page, 'record-departure').getByRole('button', { name: m.shipment.recordDeparture, exact: true }).click();
      await expect(status.getByTestId('status-fix-saved')).toBeVisible();
      await page.screenshot({ path: `${SHOT_DIR}/status-fix-saved-${locale}.png` });
      await status.locator('[data-status="IN_TRANSIT_TO_EGYPT"]').click();
      await expect(page.getByTestId('cycle-status')).toHaveText(m.codes.cycleStatus.IN_TRANSIT_TO_EGYPT);

      await page.getByTestId('change-status').click();
      await status.locator('[data-status="ARRIVED_EGYPT"]').click();
      await expect(status.getByTestId('status-fix')).toBeVisible();
      await page.screenshot({ path: `${SHOT_DIR}/status-refusal-fix-arrived-${locale}.png` });
      await status.getByTestId('status-fix').click();
      await expect(dialog(page, 'record-delivery')).toBeVisible();
      await page.screenshot({ path: `${SHOT_DIR}/record-delivery-from-status-${locale}.png` });
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');

      await page.setViewportSize({ width: 375, height: 812 });
      await page.reload();
      await expect(page.getByTestId('goods-location')).toBeVisible();
      await page.screenshot({ path: `${SHOT_DIR}/cycle-details-cards-${locale}-phone-top.png` });
      await page.setViewportSize({ width: 375, height: 3000 });
      await page.screenshot({ path: `${SHOT_DIR}/cycle-details-cards-${locale}-phone.png` });
    });
  }
});
