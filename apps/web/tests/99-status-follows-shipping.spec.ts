/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: L3 — a cycle's status follows its shipment
 * ═══════════════════════════════════════════════════════════════════════
 *  Owner, 2026-10-11 (BUSINESS_LOGIC §1): recording a departure or a
 *  delivery moves the cycle forward to the furthest status that record
 *  proves, through each step's own checks — never back, never past a step
 *  that refuses, never a cycle being settled, closed or cancelled. The
 *  office app says where the cycle landed in the success toast and shows it
 *  without a reload.
 *
 *  The screens are reached by clicking, the way a person does (CLAUDE.md §2);
 *  cycles are built through the API as a partner (§4). Unit tests for the
 *  same rules: apps/api/src/modules/shipping/status-follows-shipping.spec.ts,
 *  the assistant's previews in apps/api/src/modules/assistant/tools/deliveries.spec.ts.
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { API, apiCtx, daysAgo } from './support/fixtures';
import { day, login, messages, openNav, pickDate } from './support/ui';

const en = messages('en');
type Headers = Record<string, string>;

/** A cycle with 40 brake pads on a draft order and its legs, none departed unless asked. */
async function cycleWithLegs(
  request: APIRequestContext,
  route: 'CHINA' | 'UAE_DIRECT',
  opts: { departed?: number[]; status?: string[] } = {},
) {
  const { headers, mk } = await apiCtx(request);
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const pad = await mk('products', { name: `L3 ${stamp} Brake pad`, minStock: 0 });
  const supplier = await mk('suppliers', { name: `L3 ${stamp} Supplier`, country: 'CN' });
  const cycle = await mk('cycles', { originType: route, currency: 'EGP' });
  const po = await mk(`cycles/${cycle.id}/purchases`, {
    supplierId: supplier.id, currency: 'EGP', fxRateToEgp: 1, orderedOn: daysAgo(25),
    items: [{ productId: pad.id, orderedQty: 40, unitPrice: 100 }],
  });
  for (const status of opts.status ?? []) await mk(`cycles/${cycle.id}/transition`, { status });
  const places =
    route === 'CHINA'
      ? [['Guangzhou, CN', 'Dubai, UAE'], ['Dubai, UAE', 'Cairo, Egypt']]
      : [['Dubai, UAE', 'Cairo, Egypt']];
  const legs = [];
  for (let i = 0; i < places.length; i++) {
    const res = await request.post(`${API}/cycles/${cycle.id}/shipping-legs`, {
      headers,
      data: {
        sequence: i + 1, origin: places[i][0], destination: places[i][1],
        costBasis: 'FLAT', amount: 0, currency: 'EGP', fxRateToEgp: 1,
        ...(opts.departed?.includes(i + 1) ? { departedOn: daysAgo(20 - i * 10) } : {}),
      },
    });
    expect(res.ok(), await res.text()).toBeTruthy();
    legs.push((await res.json()).data);
  }
  const full = await (await request.get(`${API}/cycles/${cycle.id}`, { headers })).json();
  const item = (full.data ?? full).purchaseOrders[0].items[0] as { id: string };
  return { headers, cycle, legs, item, po };
}

async function cycleNow(request: APIRequestContext, headers: Headers, id: string) {
  const r = await (await request.get(`${API}/cycles/${id}`, { headers })).json();
  return (r.data ?? r) as { status: string; purchaseOrders: Array<{ id: string; status: string }> };
}

const depart = (request: APIRequestContext, headers: Headers, legId: string, day: string) =>
  request.put(`${API}/shipping/legs/${legId}`, { headers, data: { departedOn: day } });
const deliver = (request: APIRequestContext, headers: Headers, legId: string, itemId: string, qty: number, day: string) =>
  request.post(`${API}/shipping/legs/${legId}/deliveries`, {
    headers,
    data: { arrivedOn: day, lines: [{ purchaseOrderItemId: itemId, qty }] },
  });

/** Menu → Cycles → search the code → the row → its details page. */
async function openCycle(page: Page, code: string, id: string) {
  await page.locator('aside a[href="/en/cycles"]').filter({ visible: true }).first().click();
  await expect(page).toHaveURL(/\/en\/cycles$/, { timeout: 15000 });
  const main = page.getByRole('main');
  await main.getByPlaceholder(en.cycles.search).fill(code);
  await main.getByTestId('cycle-row').filter({ hasText: code }).locator('td').first().click();
  await expect(page).toHaveURL(new RegExp(`/cycles/${id}/details$`), { timeout: 15000 });
  await expect(page.getByTestId('cycle-status')).toBeVisible();
}

const legOf = (page: Page, legId: string) => page.locator(`[data-testid="shipment-leg"][data-leg-id="${legId}"]`);
const dialog = (page: Page, kind: string) => page.locator(`[data-shipment-dialog="${kind}"]`);
const moved = (done: string, status: keyof typeof en.codes.cycleStatus) =>
  `${done} — cycle is now ${en.codes.cycleStatus[status]}`;

test.describe('L3 — the office app: the record moves the cycle, and says so', () => {
  test('TC-L3-01: UAE direct in Purchasing — Record departure → "cycle is now In transit to Egypt"; a partial delivery → "Arrived Egypt"; the header follows without a reload', async ({ page, request }) => {
    const { headers, cycle, legs } = await cycleWithLegs(request, 'UAE_DIRECT', { status: ['FUNDING', 'PURCHASING'] });
    await login(page);
    await openCycle(page, cycle.code, cycle.id);
    await expect(page.getByTestId('cycle-status')).toHaveText(en.codes.cycleStatus.PURCHASING);

    await legOf(page, legs[0].id).getByTestId('record-departure').click();
    await dialog(page, 'record-departure').getByRole('button', { name: en.shipment.recordDeparture, exact: true }).click();
    await expect(page.getByText(moved(en.shipment.departureRecorded, 'IN_TRANSIT_TO_EGYPT'))).toBeVisible();
    await expect(page.getByTestId('cycle-status')).toHaveText(en.codes.cycleStatus.IN_TRANSIT_TO_EGYPT);

    // Leaving Purchasing confirmed the order — once.
    const after = await cycleNow(request, headers, cycle.id);
    expect(after.status).toBe('IN_TRANSIT_TO_EGYPT');
    expect(after.purchaseOrders.map((p) => p.status)).toEqual(['CONFIRMED']);

    await legOf(page, legs[0].id).getByTestId('record-delivery').click();
    const d = dialog(page, 'record-delivery');
    await d.getByTestId('delivery-qty').first().fill('15');
    await d.getByRole('button', { name: en.shipment.recordDelivery, exact: true }).click();
    await expect(page.getByText(moved(en.shipment.deliveryRecorded, 'ARRIVED_EGYPT'))).toBeVisible();
    await expect(page.getByTestId('cycle-status')).toHaveText(en.codes.cycleStatus.ARRIVED_EGYPT);

    // The second delivery says only that it was recorded: there was nowhere further to go.
    await legOf(page, legs[0].id).getByTestId('record-delivery').click();
    await dialog(page, 'record-delivery').getByRole('button', { name: en.shipment.recordDelivery, exact: true }).click();
    await expect(dialog(page, 'record-delivery')).toHaveCount(0);
    await expect(page.getByTestId('cycle-status')).toHaveText(en.codes.cycleStatus.ARRIVED_EGYPT);
    expect((await cycleNow(request, headers, cycle.id)).status).toBe('ARRIVED_EGYPT');
  });
});

test.describe('L3 — the Shipments page', () => {
  test('TC-L3-07: setting a departure in the leg\'s edit form → "Shipping leg updated — cycle is now In transit to Egypt"', async ({ page, request }) => {
    const { headers, cycle } = await cycleWithLegs(request, 'UAE_DIRECT', { status: ['FUNDING', 'PURCHASING'] });
    await login(page);
    await openNav(page, en.nav.shipments);
    const main = page.getByRole('main');
    await main.getByPlaceholder(en.shipments.search).fill(cycle.code);
    await main.locator('tr', { hasText: cycle.code }).getByTestId('edit-action').click();
    await pickDate(page, 'departedOn', day(-2));
    await page.getByRole('button', { name: en.common.save, exact: true }).click();
    await expect(page.getByText(moved(en.shipments.legUpdated, 'IN_TRANSIT_TO_EGYPT'))).toBeVisible();
    expect((await cycleNow(request, headers, cycle.id)).status).toBe('IN_TRANSIT_TO_EGYPT');
  });
});

test.describe('L3 — the API: what each record proves, and what it never does', () => {
  test('TC-L3-02: China, step by step — each response names the status it moved to; a second delivery moves nothing', async ({ request }) => {
    const { headers, cycle, legs, item, po } = await cycleWithLegs(request, 'CHINA', { status: ['FUNDING', 'PURCHASING'] });
    const [leg1, leg2] = legs;

    let r = await depart(request, headers, leg1.id, daysAgo(20));
    expect(r.ok(), await r.text()).toBeTruthy();
    expect((await r.json()).cycleStatus).toMatchObject({
      from: 'PURCHASING', to: 'IN_TRANSIT', moved: true, stoppedAt: null, ordersConfirmed: [po.reference],
    });

    r = await deliver(request, headers, leg1.id, item.id, 15, daysAgo(15));
    expect((await r.json()).cycleStatus).toMatchObject({ from: 'IN_TRANSIT', to: 'ARRIVED_UAE', moved: true });

    r = await depart(request, headers, leg2.id, daysAgo(10));
    expect((await r.json()).cycleStatus).toMatchObject({ from: 'ARRIVED_UAE', to: 'IN_TRANSIT_TO_EGYPT' });

    r = await deliver(request, headers, leg2.id, item.id, 5, daysAgo(5));
    expect((await r.json()).cycleStatus).toMatchObject({ from: 'IN_TRANSIT_TO_EGYPT', to: 'ARRIVED_EGYPT' });

    // Again on the same leg: no transition, nothing confirmed a second time.
    r = await deliver(request, headers, leg2.id, item.id, 5, daysAgo(4));
    expect((await r.json()).cycleStatus).toMatchObject({ to: 'ARRIVED_EGYPT', moved: false, steps: [], ordersConfirmed: [] });

    // A late leg-1 delivery does not move a cycle back.
    r = await deliver(request, headers, leg1.id, item.id, 5, daysAgo(3));
    expect((await r.json()).cycleStatus).toMatchObject({ to: 'ARRIVED_EGYPT', moved: false });
    expect((await cycleNow(request, headers, cycle.id)).status).toBe('ARRIVED_EGYPT');
  });

  test('TC-L3-03: a delivery dated before its departure is still refused, and the cycle stays', async ({ request }) => {
    const { headers, cycle, legs, item } = await cycleWithLegs(request, 'UAE_DIRECT', { status: ['FUNDING', 'PURCHASING'] });
    await depart(request, headers, legs[0].id, daysAgo(10));
    expect((await cycleNow(request, headers, cycle.id)).status).toBe('IN_TRANSIT_TO_EGYPT');
    const r = await deliver(request, headers, legs[0].id, item.id, 5, daysAgo(12));
    expect(r.status()).toBe(400);
    expect((await r.json()).error.code).toBe('DELIVERY_BEFORE_DEPARTURE');
    expect((await cycleNow(request, headers, cycle.id)).status).toBe('IN_TRANSIT_TO_EGYPT');
  });

  test('TC-L3-04: a cycle still in Planning — the departure walks it through Funding and Purchasing, confirming the order', async ({ request }) => {
    const { headers, cycle, legs } = await cycleWithLegs(request, 'CHINA');
    expect((await cycleNow(request, headers, cycle.id)).status).toBe('PLANNING');
    const r = await depart(request, headers, legs[0].id, daysAgo(10));
    expect((await r.json()).cycleStatus).toMatchObject({
      from: 'PLANNING', to: 'IN_TRANSIT', steps: ['FUNDING', 'PURCHASING', 'IN_TRANSIT'],
    });
    const now = await cycleNow(request, headers, cycle.id);
    expect(now.status).toBe('IN_TRANSIT');
    expect(now.purchaseOrders.map((p) => p.status)).toEqual(['CONFIRMED']);
  });

  test('TC-L3-06: a step whose own check refuses stops the walk there — the record still saves, and the response says why', async ({ request }) => {
    // China: leg 1 left, nothing delivered in the UAE yet; then leg 2 is
    // recorded as departed. In transit to Egypt would need Arrived UAE first,
    // and Arrived UAE needs a leg-1 delivery.
    const { headers, cycle, legs } = await cycleWithLegs(request, 'CHINA', { status: ['FUNDING', 'PURCHASING'] });
    await depart(request, headers, legs[0].id, daysAgo(20));
    const r = await depart(request, headers, legs[1].id, daysAgo(10));
    expect(r.ok(), await r.text()).toBeTruthy();
    const body = await r.json();
    expect(body.data.departedOn).toBeTruthy();
    expect(body.cycleStatus).toMatchObject({
      from: 'IN_TRANSIT', to: 'IN_TRANSIT', moved: false,
      stoppedAt: { status: 'ARRIVED_UAE', code: 'LEG_NOT_ARRIVED' },
    });
    expect((await cycleNow(request, headers, cycle.id)).status).toBe('IN_TRANSIT');
  });

  test('TC-L3-05: re-sending the departure a leg already has moves nothing', async ({ request }) => {
    const { headers, legs } = await cycleWithLegs(request, 'UAE_DIRECT', { departed: [1] });
    const first = await (await request.get(`${API}/shipping/legs?limit=100`, { headers })).json();
    const row = (first.data as Array<{ id: string; departedOn: string }>).find((l) => l.id === legs[0].id)!;
    const r = await depart(request, headers, legs[0].id, row.departedOn.slice(0, 10));
    expect(r.ok(), await r.text()).toBeTruthy();
    expect((await r.json()).cycleStatus).toBeNull();
  });
});
