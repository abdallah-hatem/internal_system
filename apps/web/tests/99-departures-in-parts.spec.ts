/* eslint-disable @typescript-eslint/no-explicit-any -- API responses are parsed JSON; each assertion names the field it checks */
/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: L8 — goods can leave in parts (owner, 2026-10-12)
 * ═══════════════════════════════════════════════════════════════════════
 *  A leg records each departure the way it records each delivery: the day it
 *  left and how many of each product went. Only what left can arrive or be
 *  lost; the goods cards split waiting-at-origin from on-the-way; the cycle's
 *  status follows only a leg's first departure. Plus, the same day: Add next
 *  leg and a leg's cost on the cycle page, through the Shipments page's own
 *  form.
 *
 *  Every screen is reached through the menu, as a person does (CLAUDE.md §2);
 *  cycles are built through the API as a partner (§4). Unit tests for the same
 *  rules: apps/api/src/modules/shipping/departures.service.spec.ts,
 *  apps/api/src/common/shipment-departures.spec.ts and
 *  apps/web/src/components/shipment/{departures,panel-legs,leg-departure-fields}.test.tsx.
 *
 *  `L8_SHOTS=1` also writes the review screenshots to .ui-audit/l8/.
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { API, apiCtx, daysAgo, PASSWORD, today } from './support/fixtures';
import { BASE, login, messages, type Locale } from './support/ui';

const INVESTOR_EMAIL = 'investor@motoparts.com';
const SHOTS = process.env.L8_SHOTS === '1';
const SHOT_DIR = '../../.ui-audit/l8';
type Headers = Record<string, string>;
const en = messages('en');

/**
 * A cycle with 40 pads and 10 chains ordered 60 days ago, its legs recorded
 * and none departed unless asked.
 */
async function cycleWithLegs(
  request: APIRequestContext,
  route: 'CHINA' | 'UAE_DIRECT',
  opts: { legs?: number } = {},
) {
  const { headers, mk } = await apiCtx(request);
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const pad = await mk('products', { name: `L8 ${stamp} Brake pad`, minStock: 0 });
  const chain = await mk('products', { name: `L8 ${stamp} Chain kit`, minStock: 0 });
  const supplier = await mk('suppliers', { name: `L8 ${stamp} Supplier`, country: 'CN' });
  const provider = await mk('providers', { name: `L8 ${stamp} Freight` });
  const cycle = await mk('cycles', { originType: route, currency: 'EGP' });
  await mk(`cycles/${cycle.id}/purchases`, {
    supplierId: supplier.id, currency: 'EGP', fxRateToEgp: 1, orderedOn: daysAgo(60),
    items: [
      { productId: pad.id, orderedQty: 40, unitPrice: 100 },
      { productId: chain.id, orderedQty: 10, unitPrice: 50 },
    ],
  });
  const route2 =
    route === 'CHINA'
      ? [['Guangzhou, CN', 'Dubai, UAE'], ['Dubai, UAE', 'Cairo, Egypt']]
      : [['Dubai, UAE', 'Cairo, Egypt']];
  const legs: any[] = [];
  for (let i = 0; i < (opts.legs ?? route2.length); i++) {
    legs.push(
      await mk(`cycles/${cycle.id}/shipping-legs`, {
        sequence: i + 1, origin: route2[i][0], destination: route2[i][1], providerId: provider.id, provider: provider.name,
        costBasis: 'FLAT', amount: 400, currency: 'EGP', fxRateToEgp: 1,
      }),
    );
  }
  const full = await (await request.get(`${API}/cycles/${cycle.id}`, { headers })).json();
  const items = (full.data ?? full).purchaseOrders[0].items as Array<{ id: string; productId: string }>;
  return {
    headers, mk, cycle, legs, pad, chain, provider,
    padItem: items.find((x) => x.productId === pad.id)!,
    chainItem: items.find((x) => x.productId === chain.id)!,
  };
}

async function api(request: APIRequestContext, method: 'post' | 'delete' | 'put', headers: Headers, path: string, data?: unknown) {
  const res = await request[method](`${API}/${path}`, { headers, ...(data === undefined ? {} : { data }) });
  const body = await res.json().catch(() => ({}));
  return { status: res.status(), body, code: body?.error?.code, params: body?.error?.params };
}
const depart = (request: APIRequestContext, h: Headers, legId: string, day: string, lines?: Array<[{ id: string }, number]>) =>
  api(request, 'post', h, `shipping/legs/${legId}/departures`, {
    departedOn: day,
    ...(lines ? { lines: lines.map(([i, qty]) => ({ purchaseOrderItemId: i.id, qty })) } : {}),
  });
const deliver = (request: APIRequestContext, h: Headers, legId: string, item: { id: string }, qty: number, day: string) =>
  api(request, 'post', h, `shipping/legs/${legId}/deliveries`, { arrivedOn: day, lines: [{ purchaseOrderItemId: item.id, qty }] });
async function shipment(request: APIRequestContext, h: Headers, cycleId: string) {
  const r = await (await request.get(`${API}/cycles/${cycleId}/shipment`, { headers: h })).json();
  return r.data ?? r;
}
async function statusOf(request: APIRequestContext, h: Headers, id: string) {
  const r = await (await request.get(`${API}/cycles/${id}`, { headers: h })).json();
  return (r.data ?? r).status as string;
}
async function tokenFor(request: APIRequestContext, email: string): Promise<Headers> {
  const r = await request.post(`${API}/auth/login`, { data: { email, password: PASSWORD } });
  expect(r.ok(), await r.text()).toBeTruthy();
  return { Authorization: `Bearer ${(await r.json()).data.accessToken}` };
}

/** Menu → Cycles → search → the row → its details page. */
async function openCycle(page: Page, code: string, id: string, locale: Locale = 'en') {
  const phone = (page.viewportSize()?.width ?? 1440) < 768;
  // On a phone the bottom bar carries Cycles (the sidebar's link is off screen).
  const links = page.locator(`a[href="/${locale}/cycles"]`).filter({ visible: true });
  await (phone ? links.last() : links.first()).click();
  await expect(page).toHaveURL(new RegExp(`/${locale}/cycles$`), { timeout: 15000 });
  const main = page.getByRole('main');
  await main.getByPlaceholder(messages(locale).cycles.search).fill(code);
  const row = phone ? main.getByTestId('cycle-card').filter({ hasText: code }).first() : main.getByTestId('cycle-row').filter({ hasText: code }).locator('td').first();
  await row.click();
  await expect(page).toHaveURL(new RegExp(`/cycles/${id}/details$`), { timeout: 15000 });
  await expect(page.getByTestId('shipment-panel')).toBeVisible();
  await expect(page.getByTestId('shipment-leg').first()).toBeVisible({ timeout: 15000 });
}

const leg = (page: Page, legId: string) => page.locator(`[data-testid="shipment-leg"][data-leg-id="${legId}"]`);
const dialog = (page: Page, kind: string) => page.locator(`[data-shipment-dialog="${kind}"]`);
const qty = (page: Page, line: string) => dialog(page, 'record-departure').locator(`[data-testid="departure-qty"][data-line="${line}"]`);

async function cards(page: Page) {
  const out: Record<string, string> = {};
  for (const c of await page.getByTestId('goods-location').getByTestId('location-card').all()) {
    out[(await c.getAttribute('data-place'))!] = (await c.getByTestId('location-value').innerText()).trim();
  }
  return out;
}

const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: `${SHOT_DIR}/${name}.png`, fullPage: true });
};

// ─── 1. Departures in parts, from the cycle page ────────────────────────

test.describe('Goods leave in parts, from the cycle page', () => {
  test('TC-L8-01: 25 of 40 pads leave, then the rest; the cards split China from on-the-way; Undo is offered only where it is allowed', async ({ page, request }) => {
    const { headers, cycle, legs, padItem, chainItem } = await cycleWithLegs(request, 'CHINA');
    await login(page);
    await openCycle(page, cycle.code, cycle.id);
    await expect.poll(() => cards(page)).toMatchObject({ inChina: '50', toUae: '0' });

    // The dialog starts every product at everything waiting.
    await leg(page, legs[0].id).getByTestId('record-departure').click();
    await expect(qty(page, padItem.id)).toHaveValue('40');
    await expect(qty(page, chainItem.id)).toHaveValue('10');
    await qty(page, padItem.id).fill('25');
    await qty(page, chainItem.id).fill('0');
    await dialog(page, 'record-departure').getByRole('button', { name: en.shipment.recordDeparture, exact: true }).click();
    await expect(dialog(page, 'record-departure')).toHaveCount(0);

    // Partly departed; 25 on the way, 25 still in China (15 pads, 10 chains).
    await expect(leg(page, legs[0].id).getByTestId('leg-status')).toHaveText(en.codes.legStatus.PARTLY_DEPARTED);
    await expect.poll(() => cards(page)).toMatchObject({ inChina: '25', toUae: '25' });
    await expect(page.getByTestId('location-row').filter({ hasText: 'Brake pad' }).locator('[data-place="inChina"]')).toHaveText('15');
    // The first departure moved the cycle on (L3).
    expect(await statusOf(request, headers, cycle.id)).toBe('IN_TRANSIT');
    await shot(page, 'cycle-partly-departed-en-1440');

    // The second visit: what is left starts at what is left, and leaves.
    await leg(page, legs[0].id).getByTestId('record-departure').click();
    await expect(qty(page, padItem.id)).toHaveValue('15');
    await expect(qty(page, chainItem.id)).toHaveValue('10');
    await dialog(page, 'record-departure').getByRole('button', { name: en.shipment.recordDeparture, exact: true }).click();
    await expect(dialog(page, 'record-departure')).toHaveCount(0);
    await expect(leg(page, legs[0].id).getByTestId('leg-status')).toHaveText(en.codes.legStatus.IN_TRANSIT);
    await expect.poll(() => cards(page)).toMatchObject({ inChina: '0', toUae: '50' });
    await expect(leg(page, legs[0].id).getByTestId('record-departure')).toHaveCount(0);
    await expect(leg(page, legs[0].id).getByTestId('shipment-departure')).toHaveCount(2);

    // Undo the second: it asks first, then the rest is back in China.
    await leg(page, legs[0].id).getByTestId('shipment-departure').nth(1).getByTestId('undo-departure').click();
    await dialog(page, 'undo-departure').getByRole('button', { name: en.shipment.undoDeparture, exact: true }).click();
    await expect(leg(page, legs[0].id).getByTestId('shipment-departure')).toHaveCount(1);
    await expect.poll(() => cards(page)).toMatchObject({ inChina: '25', toUae: '25' });

    // 20 pads reach Dubai: partly arrived AND partly departed, both said.
    expect((await deliver(request, headers, legs[0].id, padItem, 20, today())).status).toBeLessThan(300);
    await page.reload();
    await expect(leg(page, legs[0].id).getByTestId('leg-status')).toHaveText(en.codes.legStatus.PARTLY_ARRIVED, { timeout: 15000 });
    await expect(leg(page, legs[0].id).getByTestId('leg-partly-departed')).toHaveText(en.shipment.partlyDeparted);
    // The departure those pads came off is in use: no Undo now.
    await expect(leg(page, legs[0].id).getByTestId('undo-departure')).toHaveCount(0);
    await shot(page, 'cycle-partly-arrived-and-departed-en-1440');

    // A delivery of goods still in China is refused, in the dialog, translated.
    await leg(page, legs[0].id).getByTestId('record-delivery').click();
    const d = dialog(page, 'record-delivery');
    await d.locator(`[data-testid="delivery-qty"][data-line="${padItem.id}"]`).fill('6');
    await d.getByRole('button', { name: en.shipment.recordDelivery, exact: true }).click();
    await expect(d.getByTestId('shipment-refusal')).toContainText('Only 5 of');
  });

  test('TC-L8-02: leg 2 offers a departure only once goods reached Dubai, starting at what arrived; what stays in Dubai stays in the UAE card', async ({ page, request }) => {
    const { headers, cycle, legs, padItem, chainItem } = await cycleWithLegs(request, 'CHINA');
    expect((await depart(request, headers, legs[0].id, daysAgo(20))).status).toBeLessThan(300);
    await login(page);
    await openCycle(page, cycle.code, cycle.id);
    await expect(leg(page, legs[1].id).getByTestId('record-departure')).toHaveCount(0);

    expect((await deliver(request, headers, legs[0].id, padItem, 30, daysAgo(10))).status).toBeLessThan(300);
    await page.reload();
    await leg(page, legs[1].id).getByTestId('record-departure').click({ timeout: 15000 });
    await expect(qty(page, padItem.id)).toHaveValue('30');
    await expect(qty(page, chainItem.id)).toHaveCount(0);
    await qty(page, padItem.id).fill('18');
    await dialog(page, 'record-departure').getByRole('button', { name: en.shipment.recordDeparture, exact: true }).click();
    await expect(dialog(page, 'record-departure')).toHaveCount(0);
    await expect.poll(() => cards(page)).toMatchObject({ toUae: '20', inUae: '12', toEgypt: '18' });
    expect(await statusOf(request, headers, cycle.id)).toBe('IN_TRANSIT_TO_EGYPT');
  });
});

// ─── 2. The Shipments page's form, and the cycle page's Add next leg ────

test.describe('The leg forms record the first departure, and add the next leg', () => {
  test('TC-L8-03: the Shipments page edit form of a leg that has not left records its first departure, per product', async ({ page, request }) => {
    const { headers, cycle, legs, padItem, chainItem } = await cycleWithLegs(request, 'UAE_DIRECT');
    await login(page);
    await page.locator('aside a[href="/en/shipments"]').filter({ visible: true }).first().click();
    await expect(page).toHaveURL(/\/en\/shipments$/, { timeout: 15000 });
    await page.getByPlaceholder(en.shipments.search).fill(cycle.code);
    await page.getByRole('main').locator('tr', { hasText: cycle.code }).getByTestId('edit-action').click();
    const fields = page.getByTestId('leg-departure-fields');
    await fields.getByRole('button', { name: en.common.pickDate }).click();
    await page.getByTestId('date-picker-today').click();
    const padQty = fields.locator(`[data-testid="departure-qty"][data-line="${padItem.id}"]`);
    await expect(padQty).toHaveValue('40');
    await padQty.fill('12');
    await fields.locator(`[data-testid="departure-qty"][data-line="${chainItem.id}"]`).fill('0');
    await shot(page, 'shipments-edit-departure-en-1440');
    await page.getByTestId('leg-edit-form').getByRole('button', { name: en.common.save }).click();
    await expect(page.getByTestId('leg-edit-form')).toHaveCount(0, { timeout: 15000 });

    const s = await shipment(request, headers, cycle.id);
    expect(s.legs[0].departures).toHaveLength(1);
    expect(s.legs[0].departures[0].lines).toEqual([expect.objectContaining({ purchaseOrderItemId: padItem.id, qty: 12 })]);
    expect(s.legs[0].status).toBe('PARTLY_DEPARTED');
    expect(legs[0].id).toBe(s.legs[0].legId);
  });

  test('TC-L8-04: a China cycle whose leg 1 left adds leg 2 from its own page, with the shared form', async ({ page, request }) => {
    const { headers, cycle, legs, provider } = await cycleWithLegs(request, 'CHINA', { legs: 1 });
    expect((await depart(request, headers, legs[0].id, daysAgo(20))).status).toBeLessThan(300);
    await login(page);
    await openCycle(page, cycle.code, cycle.id);
    await page.getByTestId('add-next-leg').click();
    const form = page.locator('[data-leg-form="add-leg"]');
    await expect(form.locator('input[name="sequence"]')).toHaveValue('2');
    await expect(form.locator('input[name="origin"]')).toHaveValue('Dubai, UAE');
    await form.getByRole('combobox').first().click();
    await page.getByRole('option', { name: new RegExp(provider.name) }).click();
    await form.locator('input[data-field="ratePerUnit"]').fill('2.5');
    await form.locator('input[name="chargeablePieces"]').fill('50');
    await shot(page, 'cycle-add-next-leg-en-1440');
    await form.getByRole('button', { name: en.common.create }).click();
    await expect(form).toHaveCount(0, { timeout: 15000 });
    await expect(page.getByTestId('shipment-leg')).toHaveCount(2);
    await expect(page.getByTestId('add-next-leg')).toHaveCount(0);
    const s = await shipment(request, headers, cycle.id);
    expect(s.legs.map((l: any) => l.sequence)).toEqual([1, 2]);
  });

  test('TC-L8-05: once goods were lost, Edit leg shows why the cost is fixed and offers the ledger instead', async ({ page, request }) => {
    const { headers, cycle, legs, padItem } = await cycleWithLegs(request, 'UAE_DIRECT');
    expect((await depart(request, headers, legs[0].id, daysAgo(20))).status).toBeLessThan(300);
    expect((await api(request, 'post', headers, `shipping/legs/${legs[0].id}/losses`, { lines: [{ purchaseOrderItemId: padItem.id, qty: 1 }] })).status).toBeLessThan(300);
    await login(page);
    await openCycle(page, cycle.code, cycle.id);
    await leg(page, legs[0].id).getByTestId('edit-leg').click();
    const form = page.locator('[data-leg-form="edit-leg"]');
    await expect(form.getByTestId('leg-cost-locked')).toBeVisible({ timeout: 15000 });
    await expect(form.locator('input[data-field="amount"]')).toHaveCount(0);
    await shot(page, 'cycle-edit-leg-cost-locked-en-1440');
  });
});

// ─── 3. The API, tried the way a careless or hostile caller would ────────

test.describe('Departures through the API', () => {
  test('TC-L8-06: too many, zero, the future, before the order, before Dubai, someone else’s line — each refused with its code, nothing written', async ({ request }) => {
    const { headers, cycle, legs, padItem } = await cycleWithLegs(request, 'CHINA');
    const other = await cycleWithLegs(request, 'UAE_DIRECT');
    const cases: Array<[string, Promise<any>, string | number]> = [
      ['more than waits', depart(request, headers, legs[0].id, daysAgo(5), [[padItem, 41]]), 'DEPARTURE_EXCEEDS_WAITING'],
      ['zero', depart(request, headers, legs[0].id, daysAgo(5), [[padItem, 0]]), 'QTY_NOT_POSITIVE'],
      ['negative', depart(request, headers, legs[0].id, daysAgo(5), [[padItem, -3]]), 'QTY_NOT_POSITIVE'],
      ['tomorrow', depart(request, headers, legs[0].id, (() => { const d = new Date(); d.setDate(d.getDate() + 2); return d.toISOString().slice(0, 10); })(), [[padItem, 1]]), 'DATE_IN_FUTURE'],
      ['before the order', depart(request, headers, legs[0].id, daysAgo(61), [[padItem, 1]]), 'DEPARTURE_BEFORE_ORDER'],
      ['leg 2 before Dubai', depart(request, headers, legs[1].id, daysAgo(5)), 'DEPARTURE_NOTHING_WAITING'],
      ['another cycle’s line', depart(request, headers, legs[0].id, daysAgo(5), [[other.padItem, 1]]), 404],
      ['no such leg', depart(request, headers, '00000000-0000-4000-8000-000000000000', daysAgo(5), [[padItem, 1]]), 404],
    ];
    for (const [name, p, want] of cases) {
      const r = await p;
      if (typeof want === 'number') expect(r.status, name).toBe(want);
      else expect(r.code, `${name}: ${JSON.stringify(r.body)}`).toBe(want);
    }
    const s = await shipment(request, headers, cycle.id);
    expect(s.legs.flatMap((l: any) => l.departures)).toEqual([]);
    expect(await statusOf(request, headers, cycle.id)).toBe('PLANNING');
  });

  test('TC-L8-07: leg 2 dated before the leg-1 delivery that brought the goods → refused; on that day → accepted', async ({ request }) => {
    const { headers, legs, padItem } = await cycleWithLegs(request, 'CHINA');
    await depart(request, headers, legs[0].id, daysAgo(30));
    await deliver(request, headers, legs[0].id, padItem, 20, daysAgo(15));
    const early = await depart(request, headers, legs[1].id, daysAgo(16), [[padItem, 5]]);
    expect(early.code).toBe('DEPARTURE_BEFORE_ARRIVAL');
    expect((await depart(request, headers, legs[1].id, daysAgo(15), [[padItem, 5]])).status).toBeLessThan(300);
    // A delivery on leg 2 of more than left is refused; of what left, accepted.
    expect((await deliver(request, headers, legs[1].id, padItem, 6, daysAgo(5))).code).toBe('DELIVERY_EXCEEDS_IN_TRANSIT');
    expect((await deliver(request, headers, legs[1].id, padItem, 5, daysAgo(5))).status).toBeLessThan(300);
  });

  test('TC-L8-08: undo — refused once goods from it arrived, and when the cycle’s status rests on it; a free one goes, twice is 404', async ({ request }) => {
    const { headers, mk, cycle, legs, padItem } = await cycleWithLegs(request, 'UAE_DIRECT');
    const first = await depart(request, headers, legs[0].id, daysAgo(20), [[padItem, 20]]);
    const second = await depart(request, headers, legs[0].id, daysAgo(18), [[padItem, 20]]);
    // Only the first moved the cycle (L3).
    expect(first.body.cycleStatus).toMatchObject({ moved: true, to: 'IN_TRANSIT_TO_EGYPT' });
    expect(second.body.cycleStatus).toBeNull();

    await deliver(request, headers, legs[0].id, padItem, 5, daysAgo(10));
    const used = await api(request, 'delete', headers, `shipping/departures/${first.body.data.id}`);
    expect(used.code).toBe('DEPARTURE_IN_USE');
    expect(used.params).toEqual({ why: 'used' });
    expect((await api(request, 'delete', headers, `shipping/departures/${second.body.data.id}`)).status).toBeLessThan(300);
    expect((await api(request, 'delete', headers, `shipping/departures/${second.body.data.id}`)).status).toBe(404);

    // A fresh cycle whose only departure put it in transit to Egypt.
    const b = await cycleWithLegs(request, 'UAE_DIRECT');
    const only = await depart(request, b.headers, b.legs[0].id, daysAgo(20), [[b.padItem, 1]]);
    const status = await api(request, 'delete', b.headers, `shipping/departures/${only.body.data.id}`);
    expect(status.code).toBe('DEPARTURE_IN_USE');
    expect(status.params).toEqual({ why: 'status' });
    // Refused, so the cycle stays where the departure put it; never moved back.
    expect(await statusOf(request, b.headers, b.cycle.id)).toBe('IN_TRANSIT_TO_EGYPT');
    expect(await statusOf(request, headers, cycle.id)).toBe('ARRIVED_EGYPT');
    void mk;
  });

  test('TC-L8-09: an investor is refused both departure endpoints with a code; a partner still gets through', async ({ request }) => {
    const { headers, legs, padItem } = await cycleWithLegs(request, 'UAE_DIRECT');
    const investor = await tokenFor(request, INVESTOR_EMAIL);
    const r = await depart(request, investor, legs[0].id, daysAgo(5), [[padItem, 1]]);
    expect(r.status).toBe(403);
    expect(r.code).toBe('ROLE_NOT_ALLOWED');
    const ok = await depart(request, headers, legs[0].id, daysAgo(5), [[padItem, 1]]);
    expect(ok.status).toBeLessThan(300);
    const del = await api(request, 'delete', investor, `shipping/departures/${ok.body.data.id}`);
    expect(del.status).toBe(403);
    expect(del.code).toBe('ROLE_NOT_ALLOWED');
  });
});

// ─── 4. Screenshots, both languages, both widths ────────────────────────

test.describe('Screens', () => {
  test.skip(!SHOTS, 'screenshots only with L8_SHOTS=1');
  for (const locale of ['en', 'ar'] as const) {
    for (const [w, h] of [[1440, 900], [390, 844]] as const) {
      test(`TC-L8-SHOT (${locale}, ${w}): the Shipment panel mid-shipment, the departure dialog, Add leg and Edit leg`, async ({ page, request }) => {
        const m = messages(locale);
        const { headers, cycle, legs, padItem } = await cycleWithLegs(request, 'CHINA');
        await depart(request, headers, legs[0].id, daysAgo(20), [[padItem, 25]]);
        await deliver(request, headers, legs[0].id, padItem, 20, daysAgo(10));
        await depart(request, headers, legs[1].id, daysAgo(8), [[padItem, 12]]);
        await page.setViewportSize({ width: w, height: h });
        await login(page, locale);
        await openCycle(page, cycle.code, cycle.id, locale);
        await page.screenshot({ path: `${SHOT_DIR}/panel-${locale}-${w}.png`, fullPage: true });
        // The page scrolls inside its own frame, so the panel gets its own shot.
        await page.getByTestId('shipment-panel').screenshot({ path: `${SHOT_DIR}/shipment-panel-${locale}-${w}.png` });
        await leg(page, legs[0].id).getByTestId('record-departure').click();
        await expect(dialog(page, 'record-departure')).toBeVisible();
        await page.screenshot({ path: `${SHOT_DIR}/departure-dialog-${locale}-${w}.png`, fullPage: false });
        await dialog(page, 'record-departure').getByRole('button', { name: m.common.cancel }).click();
        await leg(page, legs[1].id).getByTestId('edit-leg').click();
        await expect(page.locator('[data-leg-form="edit-leg"]')).toBeVisible();
        await page.screenshot({ path: `${SHOT_DIR}/edit-leg-${locale}-${w}.png`, fullPage: false });
        await page.locator('[data-leg-form="edit-leg"]').getByRole('button', { name: m.common.cancel }).click();

        // Add next leg, on a China cycle whose leg 2 was never added.
        const one = await cycleWithLegs(request, 'CHINA', { legs: 1 });
        await depart(request, one.headers, one.legs[0].id, daysAgo(20));
        // Straight to its page: the list was loaded before this cycle existed.
        await page.goto(`${BASE}/${locale}/cycles/${one.cycle.id}/details`);
        await expect(page.getByTestId('shipment-leg').first()).toBeVisible({ timeout: 15000 });
        await page.getByTestId('add-next-leg').click();
        await expect(page.locator('[data-leg-form="add-leg"]')).toBeVisible();
        await page.screenshot({ path: `${SHOT_DIR}/add-leg-${locale}-${w}.png`, fullPage: false });
        await page.locator('[data-leg-form="add-leg"]').getByRole('button', { name: m.common.cancel }).click();

        // The Shipments page's edit form on a leg that has not left, a day picked.
        const fresh = await cycleWithLegs(request, 'UAE_DIRECT');
        await page.goto(`${BASE}/${locale}/shipments`);
        await page.getByPlaceholder(m.shipments.search).fill(fresh.cycle.code);
        const row = w < 768 ? page.getByRole('main') : page.getByRole('main').locator('tr', { hasText: fresh.cycle.code });
        await row.getByTestId('edit-action').filter({ visible: true }).first().click();
        const fields = page.getByTestId('leg-departure-fields');
        await fields.getByRole('button', { name: m.common.pickDate }).click();
        await page.getByTestId('date-picker-today').click();
        await expect(fields.getByTestId('departure-qty').first()).toBeVisible();
        await page.screenshot({ path: `${SHOT_DIR}/shipments-edit-${locale}-${w}.png`, fullPage: false });
      });
    }
  }
});
