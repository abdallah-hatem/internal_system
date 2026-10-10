/* eslint-disable @typescript-eslint/no-explicit-any -- API responses are parsed JSON; each assertion names the field it checks */
/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: Undo a refund (plan B5b)
 * ═══════════════════════════════════════════════════════════════════════
 *  BUSINESS_LOGIC §6: a refunded loss cannot be taken back; "if they do turn
 *  up, the refund is undone first — money handed back is a ledger correction
 *  — and then the loss". §9: a correction is a balancing entry pointing back
 *  at the original; reversing twice is refused; a reason is required; a
 *  flow-raised entry is reversed through its own path, not the ledger's.
 *
 *  Every API case is also a unit test in
 *  apps/api/src/modules/purchases/refund-reversal.spec.ts under the same
 *  name; the foreign keys and the race run against real Postgres in
 *  refund-reversal.db.spec.ts. The screen cases reach the Shipment panel by
 *  clicking after the login page (CLAUDE.md §2) — a `page.goto` would wipe
 *  the query cache a stale-figure bug lives in.
 */
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { API, EMAIL, PASSWORD, apiCtx, daysAgo, today } from './support/fixtures';
import en from '../src/i18n/locales/en.json';

const BASE = process.env.WEB_URL ?? 'http://localhost:3000';
type Headers = Record<string, string>;

async function accountWithRole(request: APIRequestContext, role: string) {
  const { headers } = await apiCtx(request);
  const stamp = `${Date.now()}${Math.floor(performance.now() % 1000)}`;
  const email = `undo-refund-${role.toLowerCase()}-${stamp}@motoparts.com`;
  const made = await request.post(`${API}/auth/register`, {
    headers,
    data: { email, password: 'password123', displayName: `Undo refund ${stamp}`, role },
  });
  expect(made.ok(), `create ${role}: ${await made.text()}`).toBeTruthy();
  const signedIn = await request.post(`${API}/auth/login`, {
    data: { email, password: 'password123' },
  });
  return { Authorization: `Bearer ${(await signedIn.json()).data.accessToken}` };
}

/**
 * A UAE-direct cycle walked to In transit to Egypt: 40 of one product at 100
 * and a 400 leg run by a recorded shipping company, departed 20 days ago; 5
 * marked lost on the way (110 a unit → a 550 loss). Built through the API as
 * the business would (rule 4); what is under test is done afterwards.
 */
async function cycleWithALoss(request: APIRequestContext) {
  const { headers, mk } = await apiCtx(request);
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const product = await mk('products', { name: `Undo ${stamp} Part`, minStock: 0 });
  const supplier = await mk('suppliers', { name: `Undo ${stamp} Supplier`, country: 'AE' });
  const provider = await mk('providers', { name: `Undo ${stamp} Freight` });
  const cycle = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'EGP' });
  const po = await mk(`cycles/${cycle.id}/purchases`, {
    supplierId: supplier.id, currency: 'EGP', fxRateToEgp: 1, orderedOn: daysAgo(25),
    items: [{ productId: product.id, orderedQty: 40, unitPrice: 100 }],
  });
  const leg = await mk(`cycles/${cycle.id}/shipping-legs`, {
    sequence: 1, origin: 'Dubai, UAE', destination: 'Cairo, Egypt',
    providerId: provider.id, provider: provider.name,
    costBasis: 'FLAT', amount: 400, currency: 'EGP', fxRateToEgp: 1, departedOn: daysAgo(20),
  });
  for (const status of ['FUNDING', 'PURCHASING', 'ARRIVED_UAE', 'IN_TRANSIT_TO_EGYPT']) {
    await mk(`cycles/${cycle.id}/transition`, { status });
  }
  const full = await (await request.get(`${API}/cycles/${cycle.id}`, { headers })).json();
  const item = (full.data ?? full).purchaseOrders[0].items[0];
  const [loss] = await mk(`shipping/legs/${leg.id}/losses`, {
    lines: [{ purchaseOrderItemId: item.id, qty: 5 }],
  });
  return { headers, mk, cycle, po, leg, item, loss, product, supplier, provider };
}

async function post(request: APIRequestContext, headers: Headers, path: string, data: unknown) {
  const res = await request.post(`${API}/${path}`, { headers, data });
  const body = await res.json().catch(() => ({}));
  return { status: res.status(), body, code: body?.error?.code, params: body?.error?.params };
}

const refund = async (
  request: APIRequestContext,
  headers: Headers,
  lossId: string,
  payer: { type: string; id: string },
  amount: number,
) => {
  const r = await post(request, headers, `shipping/losses/${lossId}/refunds`, {
    amount, currency: 'EGP', fxRateToEgp: 1, recordedOn: today(), payer,
  });
  expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
  return r.body.data ?? r.body;
};

const undo = (request: APIRequestContext, headers: Headers, refundId: string, reason?: unknown) =>
  post(request, headers, `purchases/refunds/${refundId}/reverse`, reason === undefined ? {} : { reason });

async function lossRead(request: APIRequestContext, headers: Headers, cycleId: string, lossId: string) {
  const s = (await (await request.get(`${API}/cycles/${cycleId}/shipment`, { headers })).json()).data;
  return s.losses.find((x: { id: string }) => x.id === lossId);
}

async function ledgerRows(request: APIRequestContext, headers: Headers, cycleId: string) {
  const body = await (await request.get(`${API}/ledger?cycleId=${cycleId}&limit=50`, { headers })).json();
  return (body.data?.items ?? body.data ?? []) as any[];
}

const fromProvider = (p: { id: string }) => ({ type: 'SHIPPING_PROVIDER', id: p.id });
const fromSupplier = (s: { id: string }) => ({ type: 'SUPPLIER', id: s.id });

// ─── The API (the plan's edge cases) ───────────────────────────────────────

test.describe('POST /purchases/refunds/:id/reverse', () => {
  test('TC-UR-01: Reverse a loss refund → a balancing OUTFLOW pointing at the original; the loss is unrecovered again; profit falls by it', async ({ request }) => {
    const { headers, cycle, loss, provider } = await cycleWithALoss(request);
    const preview = async () =>
      (await (await request.get(`${API}/settlements/preview/${cycle.id}`, { headers })).json()).data;
    const before = await preview();
    const r = await refund(request, headers, loss.id, fromProvider(provider), 200);
    const refunded = await preview();

    const u = await undo(request, headers, r.id, 'The goods turned up');
    expect(u.status, JSON.stringify(u.body)).toBeLessThan(300);

    const rows = await ledgerRows(request, headers, cycle.id);
    const original = rows.find((t) => t.relatedId === r.id && !t.reversalOfId);
    const reversal = rows.find((t) => t.reversalOfId === original.id);
    expect(original.direction).toBe('INFLOW');
    expect(reversal).toEqual(expect.objectContaining({ direction: 'OUTFLOW', category: 'loss_refund', relatedId: r.id }));
    expect(Number(reversal.amount)).toBe(200);

    const read = await lossRead(request, headers, cycle.id, loss.id);
    expect(read.refundedEgp).toBe('0.00');
    expect(read.unrecoveredEgp).toBe('550.00');
    expect(read.refunds[0].reversedAt).toBeTruthy();

    const after = await preview();
    if (before && refunded && after) {
      expect(Number(refunded.grossProfitEgp) - Number(before.grossProfitEgp)).toBeCloseTo(200, 2);
      expect(Number(after.grossProfitEgp)).toBeCloseTo(Number(before.grossProfitEgp), 2);
    }
  });

  test('TC-UR-02: After every refund on a loss is reversed → the loss can be taken back', async ({ request }) => {
    const { headers, cycle, loss, provider, supplier } = await cycleWithALoss(request);
    const a = await refund(request, headers, loss.id, fromProvider(provider), 100);
    const b = await refund(request, headers, loss.id, fromSupplier(supplier), 50);
    await undo(request, headers, a.id, 'turned up');

    const still = await request.delete(`${API}/shipping/losses/${loss.id}`, { headers });
    expect(still.status()).toBe(400);
    expect((await still.json()).error.code).toBe('LOSS_REFUNDED');

    await undo(request, headers, b.id, 'turned up');
    const gone = await request.delete(`${API}/shipping/losses/${loss.id}`, { headers });
    expect(gone.status(), await gone.text()).toBeLessThan(300);
    expect(await lossRead(request, headers, cycle.id, loss.id)).toBeUndefined();
  });

  test('TC-UR-03: Reverse twice → refused', async ({ request }) => {
    const { headers, cycle, loss, provider } = await cycleWithALoss(request);
    const r = await refund(request, headers, loss.id, fromProvider(provider), 100);
    expect((await undo(request, headers, r.id, 'once')).status).toBeLessThan(300);
    const again = await undo(request, headers, r.id, 'twice');
    expect(again.status).toBe(400);
    expect(again.code).toBe('ENTRY_ALREADY_REVERSED');
    expect((await ledgerRows(request, headers, cycle.id)).filter((t) => t.reversalOfId)).toHaveLength(1);
  });

  test('TC-UR-04: Two undos sent at once → one balancing entry, the other refused, not a 500', async ({ request }) => {
    const { headers, cycle, loss, provider } = await cycleWithALoss(request);
    const r = await refund(request, headers, loss.id, fromProvider(provider), 100);
    const results = await Promise.all([0, 1].map(() => undo(request, headers, r.id, 'double click')));
    expect(results.map((x) => x.status).sort()).toEqual([201, 400]);
    expect(results.find((x) => x.status === 400)!.code).toBe('ENTRY_ALREADY_REVERSED');
    expect((await ledgerRows(request, headers, cycle.id)).filter((t) => t.reversalOfId)).toHaveLength(1);
  });

  test('TC-UR-05: Reverse without a reason → refused', async ({ request }) => {
    const { headers, cycle, loss, provider } = await cycleWithALoss(request);
    const r = await refund(request, headers, loss.id, fromProvider(provider), 100);
    for (const reason of [undefined, '', '   ']) {
      const u = await undo(request, headers, r.id, reason);
      expect(u.status).toBe(400);
      expect(u.code).toBe('VALIDATION_FAILED');
    }
    expect((await lossRead(request, headers, cycle.id, loss.id)).refundedEgp).toBe('100.00');
  });

  test('TC-UR-06: A reversed refund no longer counts toward the loss cap or the order cap', async ({ request }) => {
    const { headers, loss, provider, po } = await cycleWithALoss(request);
    const full = await refund(request, headers, loss.id, fromProvider(provider), 550);
    const over = await post(request, headers, `shipping/losses/${loss.id}/refunds`, {
      amount: 1, currency: 'EGP', fxRateToEgp: 1, recordedOn: today(), payer: fromProvider(provider),
    });
    expect(over.code).toBe('REFUND_EXCEEDS_LOSS');
    await undo(request, headers, full.id, 'handed back');
    await refund(request, headers, loss.id, fromProvider(provider), 550);

    // Order cap: 4,000 of goods, 550 standing → 3,450 fits; undo it and it fits again.
    const plain = await post(request, headers, `purchases/${po.id}/refunds`, {
      amount: 3450, currency: 'EGP', fxRateToEgp: 1, recordedOn: today(),
    });
    expect(plain.status, JSON.stringify(plain.body)).toBeLessThan(300);
    await undo(request, headers, (plain.body.data ?? plain.body).id, 'handed back');
    const again = await post(request, headers, `purchases/${po.id}/refunds`, {
      amount: 3450, currency: 'EGP', fxRateToEgp: 1, recordedOn: today(),
    });
    expect(again.status, JSON.stringify(again.body)).toBeLessThan(300);
  });

  test('TC-UR-07: The refund’s own ledger row cannot be reversed alone through the ledger endpoint', async ({ request }) => {
    const { headers, cycle, loss, provider } = await cycleWithALoss(request);
    const r = await refund(request, headers, loss.id, fromProvider(provider), 100);
    const original = (await ledgerRows(request, headers, cycle.id)).find((t) => t.relatedId === r.id);
    const alone = await post(request, headers, `ledger/${original.id}/reverse`, { reason: 'back door' });
    expect(alone.status).toBe(400);
    expect(alone.code).toBe('ENTRY_OWNED_ELSEWHERE');
    expect((await lossRead(request, headers, cycle.id, loss.id)).refundedEgp).toBe('100.00');
  });

  test('TC-UR-08: Investor or shop → refused with a code', async ({ request }) => {
    const { headers, loss, provider } = await cycleWithALoss(request);
    const r = await refund(request, headers, loss.id, fromProvider(provider), 100);
    for (const role of ['TEMP_INVESTOR', 'SHOP_OWNER_PORTAL']) {
      const other = await accountWithRole(request, role);
      const u = await undo(request, other, r.id, 'not mine to undo');
      expect(u.status).toBe(403);
      expect(u.code).toBe('ROLE_NOT_ALLOWED');
    }
  });

  test('TC-UR-09: Unknown refund → 404', async ({ request }) => {
    const { headers } = await apiCtx(request);
    for (const id of ['00000000-0000-4000-8000-000000000000', 'not-a-uuid']) {
      const u = await undo(request, headers, id, 'nothing there');
      expect(u.status).toBe(404);
      expect(u.code).toBe('NOT_FOUND');
    }
  });
});

// ─── On screen, reached by clicking ────────────────────────────────────────

async function login(page: Page) {
  await page.goto(`${BASE}/en/login`);
  await page.getByPlaceholder('partner.a@motoparts.com').fill(EMAIL);
  await page.getByPlaceholder('••••••••').fill(PASSWORD);
  await page.getByRole('button', { name: en.auth.login, exact: true }).click();
  await expect(page).toHaveURL(/dashboard/, { timeout: 10000 });
}

async function openCycle(page: Page, code: string) {
  const link = () => page.getByRole('link', { name: en.nav.cycles, exact: true }).filter({ visible: true }).first();
  if ((await link().count()) === 0) {
    await page.locator('button:has(svg.lucide-menu)').filter({ visible: true }).first().click();
  }
  await link().click();
  await page.getByPlaceholder(en.cycles.search).fill(code);
  await page.locator('tr', { hasText: code }).getByRole('button', { name: en.common.details }).click();
  await expect(page.getByRole('heading', { name: code })).toBeVisible();
}

const shipmentDialog = (page: Page, name: string) => page.locator(`[data-shipment-dialog="${name}"]`);

test.describe('Undo refund on the Shipment panel', () => {
  test('TC-UR-20: undo needs a reason; one click undoes it; the loss reads unrecovered and can then be taken back — no reload', async ({ page, request }) => {
    const { headers, cycle, loss, provider } = await cycleWithALoss(request);
    await refund(request, headers, loss.id, fromProvider(provider), 200);

    await login(page);
    await openCycle(page, cycle.code);
    const lossRow = page.getByTestId('shipment-loss').first();
    await expect(lossRow.getByTestId('loss-unrecovered')).toContainText('350.00');
    await expect(lossRow.getByTestId('take-back-loss')).toHaveCount(0);

    await lossRow.getByTestId('undo-refund').click();
    const dialog = shipmentDialog(page, 'undo-refund');
    const confirm = dialog.getByRole('button', { name: en.shipment.undoRefund });
    await confirm.click();
    await expect(dialog.getByTestId('shipment-refusal')).toHaveText(en.shipment.undoRefundReasonRequired);

    await dialog.locator('#undo-refund-reason').pressSequentially('The goods turned up');
    const posts: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().includes('/reverse')) posts.push(r.url());
    });
    await confirm.dblclick();
    await expect(dialog).toHaveCount(0);
    expect(posts).toHaveLength(1);

    // Refreshed in place, not by a reload.
    await expect(lossRow.getByTestId('loss-unrecovered')).toContainText('550.00');
    await expect(lossRow.getByTestId('loss-refund')).toHaveAttribute('data-reversed', 'true');
    await expect(lossRow.getByTestId('undo-refund')).toHaveCount(0);

    await lossRow.getByTestId('take-back-loss').click();
    await shipmentDialog(page, 'take-back-loss').getByRole('button', { name: en.shipment.takeBack }).click();
    await expect(page.getByTestId('shipment-loss')).toHaveCount(0);
  });

  test('TC-UR-21: an undo the server refuses (already undone elsewhere) is shown translated; the dialog keeps the reason', async ({ page, request }) => {
    const { headers, cycle, loss, provider } = await cycleWithALoss(request);
    const r = await refund(request, headers, loss.id, fromProvider(provider), 200);

    await login(page);
    await openCycle(page, cycle.code);
    const lossRow = page.getByTestId('shipment-loss').first();
    await lossRow.getByTestId('undo-refund').click();
    // Someone else undoes it while the dialog is open.
    expect((await undo(request, headers, r.id, 'from another tab')).status).toBeLessThan(300);

    const dialog = shipmentDialog(page, 'undo-refund');
    await dialog.locator('#undo-refund-reason').pressSequentially('turned up');
    await dialog.getByRole('button', { name: en.shipment.undoRefund }).click();
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' }).format(new Date());
    await expect(dialog.getByTestId('shipment-refusal')).toHaveText(
      en.errors.ENTRY_ALREADY_REVERSED.replace('{date}', date),
    );
    await expect(dialog.locator('#undo-refund-reason')).toHaveValue('turned up');
  });
});
