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
 *  Only the three partners use the office app (owner 2026-10-18), so the
 *  investor's menu and screens were dropped from this suite; what stays is the
 *  API refusing and scoping him, which is still the rule (rule 12).
 */
import { test, expect, APIRequestContext } from '@playwright/test';
import { API, apiCtx, EMAIL, PASSWORD } from './support/fixtures';

const INVESTOR_EMAIL = 'investor@motoparts.com';

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

test.describe('R1 — an investor sees only their own cycles', () => {

  test("TC-INV-03: another cycle's id → not found from the API", async ({ request }) => {
    const { other, investorHeaders } = await twoCycles(request);
    const res = await request.get(`${API}/cycles/${other.id}`, { headers: investorHeaders });
    expect(res.status()).toBe(404);
    expect((await res.json()).error.code).toBe('NOT_FOUND');
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
