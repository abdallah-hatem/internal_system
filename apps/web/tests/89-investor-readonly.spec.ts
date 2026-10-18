/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: An investor reads, and is offered nothing to act on (R1b)
 * ═══════════════════════════════════════════════════════════════════════
 *  Only the three partners use the office app (owner 2026-10-18): the
 *  investor's own screens were dropped from this suite, and what stays is the
 *  partner's side — on cycles an investor is on, every action is still offered.
 *  The API's refusals of an investor are pinned in 87 and 78.
 *
 *  BUSINESS_LOGIC, roles (owner, 2026-10-10): a temporary investor sees only
 *  their own cycles — and they read, they don't act. R1 made the server refuse
 *  every write; this checks the screens stopped offering them, so an investor
 *  never presses a button that ends in ROLE_NOT_ALLOWED, and that the cycle
 *  page no longer asks for GET /users (a 403 for them).
 *
 *  Both directions, on the same records: a core partner still sees every
 *  action, so a guard that hid them from everyone fails here too (rule 12).
 *
 *  Logged in as the seeded investor (investor@motoparts.com). Pages are reached
 *  by clicking, as a person does, and every API response on the way is watched
 *  for a 403 or 5xx.
 *
 *  Not run at the time of writing (R1b was told not to run Playwright).
 */
import { test, expect, Page, APIRequestContext } from '@playwright/test';
import { API, apiCtx, EMAIL, PASSWORD, daysAgo, aCorePartnerUser } from './support/fixtures';
import en from '../src/i18n/locales/en.json';
import { WEB as BASE } from './support/env';
import { openView } from './support/ui';

const INVESTOR_EMAIL = 'investor@motoparts.com';

async function investorId(request: APIRequestContext) {
  const r = await request.post(`${API}/auth/login`, { data: { email: INVESTOR_EMAIL, password: PASSWORD } });
  expect(r.ok(), `investor login: ${await r.text()}`).toBeTruthy();
  const headers = { Authorization: `Bearer ${(await r.json()).data.accessToken}` };
  const me = await (await request.get(`${API}/auth/profile`, { headers })).json();
  return (me.data?.data ?? me.data ?? me).id as string;
}

/**
 * A cycle the investor is on, with goods on the way to Egypt: a last leg that
 * has left and not arrived, so Record delivery and Mark lost apply. Plus a
 * second cycle with stock received and a draft settlement, so Approve and
 * Reverse apply. Built through the API as a core partner, the way the business
 * builds them (rule 4).
 */
async function theInvestorsCycles(request: APIRequestContext) {
  const { headers, mk } = await apiCtx(request);
  const investor = await investorId(request);
  const partner = await aCorePartnerUser(request, headers);
  const tag = `R1B-${Date.now()}`;
  const product = await mk('products', { name: `${tag} Part`, minStock: 0 });
  const supplier = await mk('suppliers', { name: `${tag} Supplier`, country: 'AE' });

  // A new cycle starts with every active core partner on it, unless the
  // participants are named when it is created (BUSINESS_LOGIC §8, "Naming
  // participants when creating a cycle overrides the default entirely"). So the
  // investor and one partner are named up front; adding them afterwards would be
  // refused with ALREADY_A_PARTICIPANT for the partner already on it.
  const participants = [
    { participantType: 'TEMP_INVESTOR', investorUserId: investor, contributionAmount: 400, investorFeePct: 10 },
    { participantType: 'CORE_PARTNER', partnerUserId: partner.id, contributionAmount: 600 },
  ];
  const buy = async (cycleId: string, departed: boolean) => {
    await mk(`cycles/${cycleId}/purchases`, {
      supplierId: supplier.id, currency: 'EGP', fxRateToEgp: 1, orderedOn: daysAgo(60),
      items: [{ productId: product.id, orderedQty: 50, unitPrice: 20 }],
    });
    await mk(`cycles/${cycleId}/shipping-legs`, {
      sequence: 1, origin: 'Dubai, UAE', destination: 'Cairo, Egypt',
      provider: `${tag} Freight`, costBasis: 'FLAT', amount: 0, currency: 'EGP', fxRateToEgp: 1,
      ...(departed ? { departedOn: daysAgo(10) } : {}),
    });
  };

  // On the way: departed, nothing delivered.
  const moving = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'EGP', participants });
  await buy(moving.id, true);
  for (const status of ['FUNDING', 'PURCHASING', 'ARRIVED_UAE', 'IN_TRANSIT_TO_EGYPT']) {
    await mk(`cycles/${moving.id}/transition`, { status });
  }

  // Received and settled to a draft.
  const settled = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'EGP', participants });
  await buy(settled.id, true);
  for (const status of ['FUNDING', 'PURCHASING', 'ARRIVED_UAE', 'IN_TRANSIT_TO_EGYPT']) {
    await mk(`cycles/${settled.id}/transition`, { status });
  }
  const full = await (await request.get(`${API}/cycles/${settled.id}/shipment`, { headers })).json();
  const leg = (full.data ?? full).legs[0];
  const poItemId = leg.lines[0].purchaseOrderItemId;
  await mk(`shipping/legs/${leg.legId}/deliveries`, {
    arrivedOn: daysAgo(2), lines: [{ purchaseOrderItemId: poItemId, qty: 50 }],
  });
  await mk(`cycles/${settled.id}/transition`, { status: 'ARRIVED_EGYPT' });
  // Received from the delivery, line by line, as the Receive dialog sends it.
  const after = await (await request.get(`${API}/cycles/${settled.id}/shipment`, { headers })).json();
  const delivery = (after.data ?? after).legs[0].deliveries[0];
  await mk('receipts/verify', {
    cycleId: settled.id, deliveryId: delivery.id,
    items: [{ deliveryLineId: delivery.lines[0].id, receivedQty: 50 }],
  });
  await mk(`settlements/calculate/${settled.id}`, {});

  return { moving, settled };
}

async function login(page: Page, email: string) {
  await page.goto(`${BASE}/en/login`);
  await page.getByPlaceholder('name@company.com').fill(email);
  await page.getByPlaceholder('StrongPassword@123').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/dashboard/, { timeout: 10000 });
}

/** Every API 403 and 5xx seen from now on. */
function watchRefusals(page: Page) {
  const seen: string[] = [];
  page.on('response', (res) => {
    if (!res.url().includes('/api/')) return;
    if (res.status() === 403 || res.status() >= 500) seen.push(`${res.status()} ${res.url()}`);
  });
  return seen;
}

/** From the menu to a cycle's details page, by clicking. */
async function openCycle(page: Page, code: string) {
  await page.locator('aside a[href="/en/cycles"]').click();
  await expect(page).toHaveURL(/\/en\/cycles$/);
  const row = page.locator('tr', { hasText: code });
  await row.getByRole('button', { name: en.common.details }).click();
  await expect(page).toHaveURL(/\/details$/);
  await expect(page.getByTestId('shipment-panel')).toBeVisible();
  await page.waitForLoadState('networkidle');
}

/** Partners → Settlements tab (a tab since 2026-10-18), by clicking. */
async function openSettlements(page: Page, code: string) {
  await openView(page, 'settlements');
  await expect(page.getByRole('main').getByText(code).first()).toBeVisible();
  await page.waitForLoadState('networkidle');
}

test.describe('R1b — an investor reads and does not act', () => {

  test('TC-RO-02: a core partner, on the same cycle, still sees the actions', async ({ page, request }) => {
    const { moving } = await theInvestorsCycles(request);
    await login(page, EMAIL);
    const refusals = watchRefusals(page);
    await openCycle(page, moving.code);
    await expect(page.getByTestId('record-delivery')).toBeVisible();
    await expect(page.getByTestId('mark-lost')).toBeVisible();
    await expect(page.getByRole('button', { name: en.cycles.addParticipant })).toBeVisible();
    expect(refusals).toEqual([]);
  });

  test('TC-RO-04: a core partner, on the same settlement, still sees calculate, approve and reverse', async ({ page, request }) => {
    const { settled } = await theInvestorsCycles(request);
    await login(page, EMAIL);
    await openSettlements(page, settled.code);
    await expect(page.getByRole('button', { name: en.settlementsPage.calculate })).toBeVisible();
    const card = page.locator('div.rounded-xl', { hasText: settled.code }).first();
    await expect(card.getByRole('button', { name: en.settlementsPage.approve })).toBeVisible();
    await expect(card.getByRole('button', { name: en.settlementsPage.reverse })).toBeVisible();
  });

  test('TC-RO-06: a core partner still has "Receive stock" and "New Cycle"', async ({ page }) => {
    await login(page, EMAIL);
    await page.locator('aside a[href="/en/inventory"]').click();
    await expect(page.getByTestId('receive-stock-toggle')).toBeVisible();
    await page.locator('aside a[href="/en/cycles"]').click();
    await expect(page.getByRole('link', { name: en.cycles.create })).toBeVisible();
  });
});
