/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: A temporary investor sees only their own cycles (R1)
 * ═══════════════════════════════════════════════════════════════════════
 *  The owner's decision of 2026-10-10 (BUSINESS_LOGIC, roles): an investor
 *  sees the cycles they put money into — costs, deliveries, losses, profit,
 *  settlement and their own payout — and nothing else. The server enforces it
 *  on every read; the menu only follows (rule 12).
 *
 *  Logged in as the seeded investor (investor@motoparts.com, prisma/seed.ts
 *  `seedTempInvestor`). Each test builds its own cycles through the API as a
 *  core partner: one the investor is on, one they are not.
 *
 *  Pages are reached by clicking the sidebar, as a person does, and every API
 *  response on the way is watched for a 403.
 *
 *  Not run at the time of writing (R1 was told not to run Playwright).
 */
import { test, expect, Page, APIRequestContext } from '@playwright/test';
import { API, apiCtx, EMAIL, PASSWORD } from './support/fixtures';

const BASE = process.env.WEB_URL ?? 'http://localhost:3000';
const INVESTOR_EMAIL = 'investor@motoparts.com';

/** The menu an investor is offered since R1 (nav-model.ts, nav-roles test). */
const INVESTOR_HREFS = [
  '/dashboard',
  '/cycles', '/purchases', '/suppliers', '/shipments', '/providers',
  '/products', '/categories', '/inventory',
  '/settlements',
  '/notifications', '/settings',
];

async function tokenFor(request: APIRequestContext, email: string) {
  const r = await request.post(`${API}/auth/login`, { data: { email, password: PASSWORD } });
  expect(r.ok(), `login ${email}: ${await r.text()}`).toBeTruthy();
  return { Authorization: `Bearer ${(await r.json()).data.accessToken}` };
}

/** A cycle the seeded investor is on, and one they are not. */
async function twoCycles(request: APIRequestContext) {
  const { headers, mk } = await apiCtx(request);
  const investorHeaders = await tokenFor(request, INVESTOR_EMAIL);
  const me = await (await request.get(`${API}/auth/profile`, { headers: investorHeaders })).json();
  const investorId: string = (me.data?.data ?? me.data ?? me).id;
  expect(investorId, 'the seeded investor has an id').toBeTruthy();

  const theirs = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'EGP' });
  await mk(`cycles/${theirs.id}/participants`, {
    participantType: 'TEMP_INVESTOR',
    investorUserId: investorId,
    contributionAmount: 4000,
    investorFeePct: 15,
  });
  const other = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'EGP' });
  return { theirs, other, partnerHeaders: headers, investorHeaders };
}

async function login(page: Page, email: string) {
  await page.goto(`${BASE}/en/login`);
  await page.getByPlaceholder('partner.a@motoparts.com').fill(email);
  await page.getByPlaceholder('••••••••').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/dashboard/, { timeout: 10000 });
}

/** Every API 403 and 500 seen from now on, except those named. */
function watchRefusals(page: Page, except: RegExp[] = []) {
  const seen: string[] = [];
  page.on('response', (res) => {
    if (res.status() !== 403 && res.status() < 500) return;
    if (except.some((r) => r.test(res.url()))) return;
    seen.push(`${res.status()} ${res.url()}`);
  });
  return seen;
}

test.describe('R1 — an investor sees only their own cycles', () => {
  test('TC-INV-01: every menu entry the investor sees opens, by clicking, with no 403', async ({ page, request }) => {
    await twoCycles(request);
    await login(page, INVESTOR_EMAIL);
    const refusals = watchRefusals(page);
    for (const href of INVESTOR_HREFS) {
      await page.locator(`aside a[href="/en${href}"]`).click();
      await expect(page).toHaveURL(new RegExp(`/en${href}$`));
      await page.waitForLoadState('networkidle');
    }
    expect(refusals).toEqual([]);
  });

  test('TC-INV-02: the cycles list shows their cycle and not the other one', async ({ page, request }) => {
    const { theirs, other } = await twoCycles(request);
    await login(page, INVESTOR_EMAIL);
    await page.locator('aside a[href="/en/cycles"]').click();
    await expect(page.getByText(theirs.code).first()).toBeVisible();
    await expect(page.getByText(other.code)).toHaveCount(0);
  });

  test("TC-INV-03: another cycle's URL → not found, from the API and on the page", async ({ page, request }) => {
    const { other, investorHeaders } = await twoCycles(request);
    const res = await request.get(`${API}/cycles/${other.id}`, { headers: investorHeaders });
    expect(res.status()).toBe(404);
    expect((await res.json()).error.code).toBe('NOT_FOUND');

    await login(page, INVESTOR_EMAIL);
    const seen = page.waitForResponse((r) => r.url().endsWith(`/cycles/${other.id}`));
    await page.goto(`${BASE}/en/cycles/${other.id}/details`);
    expect((await seen).status()).toBe(404);
    await expect(page.getByText('No data available')).toBeVisible();
    await expect(page.getByText(other.code)).toHaveCount(0);
  });

  test('TC-INV-04: their own cycle opens, with their participation and not the partners\' contributions', async ({ request }) => {
    const { theirs, investorHeaders } = await twoCycles(request);
    const res = await request.get(`${API}/cycles/${theirs.id}`, { headers: investorHeaders });
    expect(res.status()).toBe(200);
    const participants = (await res.json()).data.participants;
    expect(participants.map((p: { participantType: string }) => p.participantType)).toEqual(['TEMP_INVESTOR']);
    for (const path of [`/cycles/${theirs.id}/shipment`, `/costing/cycles/${theirs.id}/landed-cost`, `/cycles/${theirs.id}/purchases`]) {
      expect((await request.get(`${API}${path}`, { headers: investorHeaders })).status(), path).toBe(200);
    }
  });

  test('TC-INV-05: customers, payment plans, returns and business-wide analytics refuse the investor with a code; a core partner still reads them', async ({ request }) => {
    const investorHeaders = await tokenFor(request, INVESTOR_EMAIL);
    const partnerHeaders = await tokenFor(request, EMAIL);
    for (const path of [
      '/customers', '/payment-plans', '/payment-plans/overdue', '/returns',
      '/analytics/dashboard', '/analytics/revenue-by-month', '/analytics/top-products',
    ]) {
      const refused = await request.get(`${API}${path}`, { headers: investorHeaders });
      expect(refused.status(), path).toBe(403);
      expect((await refused.json()).error.code, path).toBe('ROLE_NOT_ALLOWED');
      expect((await request.get(`${API}${path}`, { headers: partnerHeaders })).status(), path).toBe(200);
    }
  });

  test("TC-INV-06: the dashboard shows the investor's cycles, not the business's figures", async ({ page, request }) => {
    await twoCycles(request);
    await login(page, INVESTOR_EMAIL);
    const refusals = watchRefusals(page);
    await expect(page.getByTestId('your-cycles')).toBeVisible();
    await expect(page.getByTestId('tile-revenue')).toHaveCount(0);
    await expect(page.getByTestId('tile-cashOnHand')).toHaveCount(0);
    await page.waitForLoadState('networkidle');
    expect(refusals).toEqual([]);
  });

  test('TC-INV-07: the investor\'s lists hold only their cycles\' rows', async ({ request }) => {
    const { theirs, other, investorHeaders } = await twoCycles(request);
    const cycles = (await (await request.get(`${API}/cycles?limit=100`, { headers: investorHeaders })).json()).data;
    const ids = cycles.map((c: { id: string }) => c.id);
    expect(ids).toContain(theirs.id);
    expect(ids).not.toContain(other.id);
    const legs = (await (await request.get(`${API}/shipping/legs?cycleId=${other.id}`, { headers: investorHeaders })).json()).data;
    expect(legs).toEqual([]);
    const pos = (await (await request.get(`${API}/purchases?cycleId=${other.id}`, { headers: investorHeaders })).json()).data;
    expect(pos).toEqual([]);
  });
});
