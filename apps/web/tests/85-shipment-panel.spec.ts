/* eslint-disable @typescript-eslint/no-explicit-any -- API responses are parsed JSON; each assertion names the field it checks */
/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: the cycle's Shipment panel, receiving and losses (plan F1a)
 * ═══════════════════════════════════════════════════════════════════════
 *  BUSINESS_LOGIC §1, §2, §3, §6 (2026-10-10). Goods arrive in deliveries;
 *  each delivery into Egypt is received into stock on its own; goods that
 *  never come are marked lost, and money given back for them is a refund on
 *  the loss.
 *
 *  Every screen is reached by clicking after the login page (CLAUDE.md §2): a
 *  `page.goto` reloads the app and wipes the query cache that a stale-list bug
 *  lives in. Fixtures build a real cycle with an order and a departed leg
 *  through the API (rule 4); every delivery, receipt, loss and refund under
 *  test is made on screen.
 */
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { API, EMAIL, PASSWORD, apiCtx, daysAgo } from './support/fixtures';
import en from '../src/i18n/locales/en.json';
import ar from '../src/i18n/locales/ar.json';

const BASE = process.env.WEB_URL ?? 'http://localhost:3000';
type Messages = typeof en;

async function login(page: Page, locale: 'en' | 'ar' = 'en') {
  await page.goto(`${BASE}/${locale}/login`);
  await page.getByPlaceholder('partner.a@motoparts.com').fill(EMAIL);
  await page.getByPlaceholder('••••••••').fill(PASSWORD);
  const m: Messages = locale === 'en' ? en : ar;
  await page.getByRole('button', { name: m.auth.login, exact: true }).click();
  await expect(page).toHaveURL(/dashboard/, { timeout: 10000 });
}

/** Through the navigation — the sidebar, or behind the menu on a phone. */
async function openNav(page: Page, name: string) {
  const link = () => page.getByRole('link', { name, exact: true }).filter({ visible: true }).first();
  if ((await link().count()) === 0) {
    await page.locator('button:has(svg.lucide-menu)').filter({ visible: true }).first().click();
  }
  await link().click();
}

/** Cycles → search by code → Details. */
async function openCycle(page: Page, code: string, m: Messages = en) {
  await openNav(page, m.nav.cycles);
  await page.getByPlaceholder(m.cycles.search).fill(code);
  await page.locator('tr', { hasText: code }).getByRole('button', { name: m.common.details }).click();
  await expect(page.getByRole('heading', { name: code })).toBeVisible();
  await expect(panel(page)).toBeVisible();
}

const panel = (page: Page) => page.getByTestId('shipment-panel');
const shipmentDialog = (page: Page, name: string) => page.locator(`[data-shipment-dialog="${name}"]`);
const line = (page: Page, product: string) =>
  panel(page).getByTestId('shipment-line').filter({ visible: true }).filter({ hasText: product }).first();
const cell = (page: Page, product: string, id: string) => line(page, product).getByTestId(id);

/**
 * 40 of one product ordered at 100 from a supplier, on a UAE-direct cycle whose
 * one leg (a recorded provider, 400 flat) departed 20 days ago and has
 * delivered nothing. The cycle is In transit to Egypt. A unit lands at 110.
 */
async function cycleOnTheWay(request: APIRequestContext, label: string) {
  const { headers, mk } = await apiCtx(request);
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const product = await mk('products', { name: `${label} ${stamp} Part`, minStock: 0 });
  const supplier = await mk('suppliers', { name: `${label} ${stamp} Supplier`, country: 'AE' });
  const provider = await mk('providers', { name: `${label} ${stamp} Freight` });
  const cycle = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'EGP' });
  await mk(`cycles/${cycle.id}/purchases`, {
    supplierId: supplier.id, currency: 'EGP', fxRateToEgp: 1, orderedOn: daysAgo(25),
    items: [{ productId: product.id, orderedQty: 40, unitPrice: 100 }],
  });
  const leg = await mk(`cycles/${cycle.id}/shipping-legs`, {
    sequence: 1, origin: 'Dubai, UAE', destination: 'Cairo, Egypt',
    providerId: provider.id, provider: provider.name,
    costBasis: 'FLAT', amount: 400, currency: 'EGP', fxRateToEgp: 1,
    departedOn: daysAgo(20),
  });
  for (const status of ['FUNDING', 'PURCHASING', 'ARRIVED_UAE', 'IN_TRANSIT_TO_EGYPT']) {
    await mk(`cycles/${cycle.id}/transition`, { status });
  }
  const full = await (await request.get(`${API}/cycles/${cycle.id}`, { headers })).json();
  const item = (full.data ?? full).purchaseOrders[0].items[0];
  return { headers, mk, cycle, product, supplier, provider, leg, item };
}

/** The same cycle with a delivery of `delivered` already in Egypt and the cycle at Arrived Egypt. */
async function cycleWithDelivery(request: APIRequestContext, label: string, delivered = 15) {
  const ctx = await cycleOnTheWay(request, label);
  await ctx.mk(`shipping/legs/${ctx.leg.id}/deliveries`, {
    arrivedOn: daysAgo(3), lines: [{ purchaseOrderItemId: ctx.item.id, qty: delivered }],
  });
  await ctx.mk(`cycles/${ctx.cycle.id}/transition`, { status: 'ARRIVED_EGYPT' });
  return ctx;
}

async function shipmentOf(request: APIRequestContext, headers: any, cycleId: string) {
  const body = await (await request.get(`${API}/cycles/${cycleId}/shipment`, { headers })).json();
  return body.data ?? body;
}

async function batchesOf(request: APIRequestContext, headers: any, productId: string) {
  const body = await (await request.get(`${API}/inventory?productId=${productId}`, { headers })).json();
  return ((body.data ?? []).find((p: any) => p.productId === productId)?.batches ?? []) as any[];
}

test.describe('Shipment panel (F1a)', () => {
  test('TC-SHP-01: record 15 of 40, receive 14 → waiting 1, on the way 25; mark 5 lost; refund it; "Receive stock" lists then clears', async ({
    page,
    request,
  }) => {
    const { headers, cycle, product, provider } = await cycleOnTheWay(request, 'SHP01');
    await login(page);
    await openCycle(page, cycle.code);

    // Record delivery, prefilled with all 40 on the way; 15 arrived.
    await panel(page).getByTestId('record-delivery').click();
    const delivery = shipmentDialog(page, 'record-delivery');
    const qty = delivery.getByRole('textbox', { name: new RegExp(product.name) });
    await expect(qty).toHaveValue('40');
    await qty.fill('15');
    await delivery.getByRole('button', { name: en.shipment.recordDelivery }).click();
    await expect(delivery).toBeHidden();
    await expect(cell(page, product.name, 'line-delivered')).toHaveText('15');
    await expect(cell(page, product.name, 'line-on-the-way')).toHaveText('25');
    await expect(panel(page).getByTestId('leg-status').first()).toHaveText(en.codes.legStatus.PARTLY_ARRIVED);

    // Receiving opens at Arrived Egypt; the panel offers the step.
    await page.getByTestId('walk-to-egypt').click();
    await expect(page.getByTestId('cycle-status')).toHaveText(en.codes.cycleStatus.ARRIVED_EGYPT);

    // Receive 14 of the 15.
    await panel(page).getByTestId('receive-delivery').click();
    const receive = shipmentDialog(page, 'receive-delivery');
    await expect(receive.getByTestId('receive-qty')).toHaveValue('15');
    await expect(receive.getByTestId('receive-unit-cost')).toContainText('110.00');
    await receive.getByTestId('receive-qty').fill('14');
    await receive.getByRole('button', { name: en.shipment.receiveIntoStock }).click();
    await expect(receive).toBeHidden();
    await expect(cell(page, product.name, 'line-received')).toHaveText('14');
    await expect(cell(page, product.name, 'line-waiting')).toHaveText('1');
    await expect(cell(page, product.name, 'line-on-the-way')).toHaveText('25');

    // Mark 5 lost: the EGP figure before the confirm, the booked one after.
    await panel(page).getByTestId('mark-lost').click();
    const lost = shipmentDialog(page, 'mark-lost');
    await lost.getByRole('textbox', { name: new RegExp(product.name) }).fill('5');
    await lost.getByRole('button', { name: en.shipment.continue }).click();
    await expect(lost.getByTestId('loss-estimate')).toContainText('550.00');
    await lost.getByRole('button', { name: en.shipment.confirmLoss }).click();
    await expect(lost.getByTestId('loss-booked')).toContainText('550.00');
    await lost.getByRole('button', { name: en.shipment.done }).click();
    await expect(cell(page, product.name, 'line-lost')).toHaveText('5');
    await expect(cell(page, product.name, 'line-on-the-way')).toHaveText('20');
    // The shown figure is the booked one.
    const booked = (await shipmentOf(request, headers, cycle.id)).legs[0].losses[0];
    expect(Number(booked.costEgp)).toBe(550);

    // Record a refund of 200 from the shipping provider.
    await panel(page).getByTestId('record-refund').click();
    const refund = shipmentDialog(page, 'record-refund');
    await expect(refund.getByTestId('refund-summary')).toContainText('550.00');
    await refund.getByRole('combobox').first().click();
    await page.getByRole('option', { name: new RegExp(provider.name) }).click();
    await refund.locator('#refund-amount').fill('200');
    await refund.getByRole('button', { name: en.shipment.recordRefund }).click();
    await expect(refund).toBeHidden();
    await expect(panel(page).getByTestId('loss-unrecovered').first()).toContainText('350.00');
    // Refunded: it can no longer be taken back.
    await expect(panel(page).getByTestId('take-back-loss')).toHaveCount(0);

    // Inventory → Receive stock lists the 1 waiting, receives it, and it is gone.
    await openNav(page, en.nav.inventory);
    await page.getByTestId('receive-stock-toggle').click();
    const row = page.getByTestId('waiting-delivery').filter({ hasText: cycle.code });
    await expect(row).toContainText(`${product.name}: 1`);
    await row.getByTestId('receive-delivery').click();
    const fromInventory = shipmentDialog(page, 'receive-delivery');
    await expect(fromInventory.getByTestId('receive-qty')).toHaveValue('1');
    await fromInventory.getByRole('button', { name: en.shipment.receiveIntoStock }).click();
    await expect(fromInventory).toBeHidden();
    await expect(page.getByTestId('waiting-delivery').filter({ hasText: cycle.code })).toHaveCount(0);

    // And back on the cycle by clicking, the panel already knows.
    await openCycle(page, cycle.code);
    await expect(cell(page, product.name, 'line-received')).toHaveText('15');
    await expect(cell(page, product.name, 'line-waiting')).toHaveText('0');
    expect((await batchesOf(request, headers, product.id)).map((b) => Number(b.receivedQty))).toEqual([14, 1]);
  });

  test('TC-SHP-02: Record delivery prefills what is on the way; a value typed over it is kept on re-render', async ({ page, request }) => {
    const { cycle, product } = await cycleOnTheWay(request, 'SHP02');
    await login(page);
    await openCycle(page, cycle.code);
    await panel(page).getByTestId('record-delivery').click();
    const d = shipmentDialog(page, 'record-delivery');
    const qty = d.getByRole('textbox', { name: new RegExp(product.name) });
    await expect(qty).toHaveValue('40');
    await qty.fill('12');
    // Re-render the dialog: type a note, and make the panel refetch underneath.
    await d.locator('#delivery-note').fill('first truck');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForTimeout(500);
    await expect(qty).toHaveValue('12');
  });

  test('TC-SHP-03: more than is on the way → the refusal in Arabic, the dialog open with its values', async ({ page, request }) => {
    const { cycle, product } = await cycleOnTheWay(request, 'SHP03');
    await login(page, 'ar');
    await openCycle(page, cycle.code, ar);
    await panel(page).getByTestId('record-delivery').click();
    const d = shipmentDialog(page, 'record-delivery');
    await d.getByRole('textbox', { name: new RegExp(product.name) }).fill('41');
    await d.getByRole('button', { name: ar.shipment.recordDelivery }).click();
    const expected = ar.errors.DELIVERY_EXCEEDS_IN_TRANSIT.replace('{onTheWay}', '40')
      .replace('{line}', product.name)
      .replace('{asked}', '41');
    await expect(d.getByTestId('shipment-refusal')).toHaveText(expected);
    await expect(d).toBeVisible();
    await expect(d.getByRole('textbox', { name: new RegExp(product.name) })).toHaveValue('41');
  });

  test('TC-SHP-04: dialogs portal to <body>; only the submit button submits', async ({ page, request }) => {
    const { cycle } = await cycleOnTheWay(request, 'SHP04');
    await login(page);
    await openCycle(page, cycle.code);
    for (const [trigger, name] of [
      ['record-delivery', 'record-delivery'],
      ['mark-lost', 'mark-lost'],
    ] as const) {
      await panel(page).getByTestId(trigger).click();
      const d = shipmentDialog(page, name);
      await expect(d).toBeVisible();
      const shape = await d.evaluate((el) => ({
        parent: el.parentElement?.tagName,
        insideForm: !!el.parentElement?.closest('form'),
        submits: Array.from(el.querySelectorAll('button')).filter((b) => b.getAttribute('type') !== 'button').length,
      }));
      expect(shape).toEqual({ parent: 'BODY', insideForm: false, submits: 1 });
      await page.keyboard.press('Escape');
      await expect(d).toBeHidden();
    }
  });

  test("TC-SHP-05: the delivery date picker greys out days after Cairo's today", async ({ page, request }) => {
    const { cycle } = await cycleOnTheWay(request, 'SHP05');
    await login(page);
    await openCycle(page, cycle.code);
    await panel(page).getByTestId('record-delivery').click();
    const d = shipmentDialog(page, 'record-delivery');
    const today = await d.locator('input[type="hidden"][name="arrivedOn"]').inputValue();
    const cairoToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(new Date());
    expect(today).toBe(cairoToday);
    await d.getByRole('button', { name: en.common.pickDate }).click();
    const tomorrow = new Date(`${cairoToday}T12:00:00Z`);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const tomorrowIso = tomorrow.toISOString().slice(0, 10);
    // Tomorrow can be in the next month; then it is simply not on this page.
    const day = page.locator(`[data-day="${tomorrowIso}"]`);
    if ((await day.count()) > 0) await expect(day).toBeDisabled();
    await expect(page.locator(`[data-day="${cairoToday}"]`)).toBeEnabled();
  });

  test('TC-SHP-06: a double-click on Receive makes one receipt', async ({ page, request }) => {
    const { headers, cycle, product } = await cycleWithDelivery(request, 'SHP06');
    await login(page);
    await openCycle(page, cycle.code);
    await panel(page).getByTestId('receive-delivery').click();
    const receive = shipmentDialog(page, 'receive-delivery');
    await receive.getByTestId('receive-qty').fill('5');
    await receive.getByRole('button', { name: en.shipment.receiveIntoStock }).dblclick();
    await expect(receive).toBeHidden();
    await expect(cell(page, product.name, 'line-received')).toHaveText('5');
    expect(await batchesOf(request, headers, product.id)).toHaveLength(1);
  });

  test('TC-SHP-07: take a loss back from the panel → the units are on the way again', async ({ page, request }) => {
    const { cycle, product } = await cycleOnTheWay(request, 'SHP07');
    await login(page);
    await openCycle(page, cycle.code);
    await panel(page).getByTestId('mark-lost').click();
    const lost = shipmentDialog(page, 'mark-lost');
    await lost.getByRole('textbox', { name: new RegExp(product.name) }).fill('10');
    await lost.getByRole('button', { name: en.shipment.continue }).click();
    await lost.getByRole('button', { name: en.shipment.confirmLoss }).click();
    await lost.getByRole('button', { name: en.shipment.done }).click();
    await expect(cell(page, product.name, 'line-on-the-way')).toHaveText('30');

    await panel(page).getByTestId('take-back-loss').click();
    await shipmentDialog(page, 'take-back-loss').getByRole('button', { name: en.shipment.takeBack }).click();
    await expect(shipmentDialog(page, 'take-back-loss')).toBeHidden();
    await expect(cell(page, product.name, 'line-on-the-way')).toHaveText('40');
    await expect(cell(page, product.name, 'line-lost')).toHaveText('0');
  });

  test('TC-SHP-08: a refund larger than the loss → REFUND_EXCEEDS_LOSS translated, values kept', async ({ page, request }) => {
    const { cycle, product, supplier } = await cycleOnTheWay(request, 'SHP08');
    await login(page);
    await openCycle(page, cycle.code);
    await panel(page).getByTestId('mark-lost').click();
    const lost = shipmentDialog(page, 'mark-lost');
    await lost.getByRole('textbox', { name: new RegExp(product.name) }).fill('2');
    await lost.getByRole('button', { name: en.shipment.continue }).click();
    await lost.getByRole('button', { name: en.shipment.confirmLoss }).click();
    await lost.getByRole('button', { name: en.shipment.done }).click();

    await panel(page).getByTestId('record-refund').click();
    const refund = shipmentDialog(page, 'record-refund');
    const summary = refund.getByTestId('refund-summary');
    await expect(summary).toContainText('220.00'); // the loss
    await expect(summary).toContainText('0.00'); // refunded so far
    await refund.getByRole('combobox').first().click();
    await page.getByRole('option', { name: new RegExp(supplier.name) }).click();
    await refund.locator('#refund-amount').fill('500');
    await refund.locator('#refund-reason').fill('supplier credit');
    await refund.getByRole('button', { name: en.shipment.recordRefund }).click();
    const alert = refund.getByTestId('shipment-refusal');
    await expect(alert).toBeVisible();
    // Translated: the app's sentence for the code, not the server's English.
    const sentence = (en.errors as unknown as Record<string, string | undefined>).REFUND_EXCEEDS_LOSS ?? '';
    expect(sentence, 'REFUND_EXCEEDS_LOSS has an English translation').toBeTruthy();
    await expect(alert).toContainText(sentence.split('{')[0].trim());
    await expect(refund).toBeVisible();
    await expect(refund.locator('#refund-amount')).toHaveValue('500');
    await expect(refund.locator('#refund-reason')).toHaveValue('supplier credit');
  });

  test('TC-SHP-09: deleting a delivery stock was received from → DELIVERY_IN_USE, translated', async ({ page, request }) => {
    const { cycle } = await cycleWithDelivery(request, 'SHP09');
    await login(page);
    await openCycle(page, cycle.code);
    await panel(page).getByTestId('receive-delivery').click();
    await shipmentDialog(page, 'receive-delivery').getByRole('button', { name: en.shipment.receiveIntoStock }).click();
    await expect(shipmentDialog(page, 'receive-delivery')).toBeHidden();

    await panel(page).getByTestId('delete-delivery').first().click();
    const confirm = shipmentDialog(page, 'delete-delivery');
    await confirm.getByRole('button', { name: en.shipment.deleteDelivery }).click();
    await expect(confirm.getByTestId('shipment-refusal')).toHaveText(en.errors.DELIVERY_IN_USE);
    await expect(confirm).toBeVisible();
  });

  test('TC-SHP-10: an empty "Receive stock" list says nothing is waiting', async ({ page }) => {
    // No cycle can have anything waiting: the list is asked for none.
    await page.route('**/api/v1/cycles?limit=200', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [] }) }),
    );
    await login(page);
    await openNav(page, en.nav.inventory);
    await page.getByTestId('receive-stock-toggle').click();
    await expect(page.getByTestId('receive-stock-list')).toContainText(en.shipment.nothingWaiting);
    await expect(page.getByTestId('waiting-delivery')).toHaveCount(0);
  });

  test('TC-SHP-11: inventory low stock follows the one rule, the same as the dashboard tile', async ({ page, request }) => {
    const { headers, mk } = await apiCtx(request);
    const stamp = `${Date.now()}`;
    const low = await mk('products', { name: `SHP11 ${stamp} Under`, minStock: 50 });
    const noMin = await mk('products', { name: `SHP11 ${stamp} NoMin` });
    // 40 of the first (under its 50), 3 of the second (no minimum, so never low).
    for (const [product, qty] of [[low, 40], [noMin, 3]] as const) {
      const supplier = await mk('suppliers', { name: `SHP11 ${stamp} ${qty} Supplier`, country: 'AE' });
      const cycle = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'EGP' });
      await mk(`cycles/${cycle.id}/purchases`, {
        supplierId: supplier.id, currency: 'EGP', fxRateToEgp: 1, orderedOn: daysAgo(25),
        items: [{ productId: product.id, orderedQty: qty, unitPrice: 10 }],
      });
      await mk(`cycles/${cycle.id}/shipping-legs`, {
        sequence: 1, origin: 'Dubai, UAE', destination: 'Cairo, Egypt',
        costBasis: 'FLAT', amount: 0, currency: 'EGP', fxRateToEgp: 1,
        departedOn: daysAgo(20), arrivedOn: daysAgo(5),
      });
      for (const status of ['FUNDING', 'PURCHASING', 'ARRIVED_UAE', 'IN_TRANSIT_TO_EGYPT', 'ARRIVED_EGYPT']) {
        await mk(`cycles/${cycle.id}/transition`, { status });
      }
      const full = await (await request.get(`${API}/cycles/${cycle.id}`, { headers })).json();
      await mk('receipts/verify', {
        cycleId: cycle.id,
        items: [{ purchaseOrderItemId: (full.data ?? full).purchaseOrders[0].items[0].id, receivedQty: qty }],
      });
    }

    await login(page);
    await page.getByTestId('tile-lowStockAlerts').click();
    await expect(page.getByTestId('low-stock-chip')).toBeVisible();
    await page.getByPlaceholder(en.inventory.search).fill(`SHP11 ${stamp}`);
    const rows = page.getByTestId('inventory-row');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toHaveAttribute('data-product', low.name);
    await expect(rows.first()).toHaveAttribute('data-low', 'true');

    await page.getByRole('button', { name: en.dashboard.showAll }).click();
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: noMin.name })).toHaveAttribute('data-low', 'false');
  });

  test('TC-SHP-12: the shipments edit form sends no status and no arrival, and points at the panel', async ({ page, request }) => {
    const { cycle } = await cycleOnTheWay(request, 'SHP12');
    await login(page);
    await openNav(page, en.nav.shipments);
    await page.getByPlaceholder(en.shipments.search).fill(cycle.code);
    await page.locator('tr', { hasText: cycle.code }).filter({ visible: true }).getByRole('button', { name: en.common.edit }).click();
    await expect(page.getByTestId('leg-arrival')).toContainText(en.codes.legStatus.IN_TRANSIT);
    const sent = page.waitForRequest((r) => r.method() === 'PUT' && /\/shipping\/legs\//.test(r.url()));
    await page.getByRole('button', { name: en.common.save }).click();
    const body = (await sent).postDataJSON();
    expect(body).not.toHaveProperty('status');
    expect(body).not.toHaveProperty('arrivedOn');

    // And the link reaches the cycle's panel by clicking.
    await page.locator('tr', { hasText: cycle.code }).filter({ visible: true }).getByRole('button', { name: en.common.edit }).click();
    await page.getByTestId('leg-open-cycle').click();
    await expect(panel(page)).toBeVisible();
  });

  test('TC-SHP-13: the cycle page profit card is the analytics figure, losses included', async ({ page, request }) => {
    const { headers, cycle, product } = await cycleWithDelivery(request, 'SHP13', 40);
    await login(page);
    await openCycle(page, cycle.code);
    await panel(page).getByTestId('receive-delivery').click();
    const receive = shipmentDialog(page, 'receive-delivery');
    await receive.getByTestId('receive-qty').fill('38');
    await receive.getByRole('button', { name: en.shipment.receiveIntoStock }).click();
    await expect(cell(page, product.name, 'line-waiting')).toHaveText('2');
    await panel(page).getByTestId('mark-lost').click();
    const lost = shipmentDialog(page, 'mark-lost');
    await lost.getByRole('textbox', { name: new RegExp(product.name) }).fill('2');
    await lost.getByRole('button', { name: en.shipment.continue }).click();
    await lost.getByRole('button', { name: en.shipment.confirmLoss }).click();
    await lost.getByRole('button', { name: en.shipment.done }).click();

    const figures = await (await request.get(`${API}/analytics/cycle-profitability`, { headers })).json();
    const mine = (figures.data ?? figures).find((r: any) => r.cycleCode === cycle.code);
    expect(mine.lossesEgp).toBe(220);
    await expect(page.getByTestId('cycle-profit-losses')).toContainText('220.00');
    await expect(page.getByTestId('cycle-profit-value')).toContainText(
      Number(mine.profit).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    );
    // The Shipment panel shows the leg's status.
    await expect(page.getByTestId('leg-status').first()).toHaveText(en.codes.legStatus.ARRIVED);
  });

  test('TC-SHP-14: on a phone the product rows are cards and nothing overflows', async ({ page, request }) => {
    const { cycle, product } = await cycleOnTheWay(request, 'SHP14');
    await login(page);
    await openCycle(page, cycle.code);
    // Narrowed in place: the phone list opens the wizard for a cycle in transit,
    // and a reload would not be reaching the page by clicking.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(line(page, product.name)).toBeVisible();
    expect(await line(page, product.name).evaluate((el) => el.tagName)).toBe('LI');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
