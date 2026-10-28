/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: Cycle details, and the participants nothing could add
 * ═══════════════════════════════════════════════════════════════════════
 *  A cycle had two fates in the list: one still in the wizard opened the
 *  wizard, one past it opened a drawer of counts. Neither showed what a cycle
 *  contained, and a closed cycle — the one you most want to look back at —
 *  showed the least.
 *
 *  Worse, no screen could add a participant. The API had the endpoint and the
 *  settlement maths expected them, so every cycle had none and settling
 *  reported "No participants found for this cycle" with no way to fix it.
 */
import { test, expect, Page, APIRequestContext } from '@playwright/test';
import { API, aCorePartnerUser, anInvestorUser, apiCtx, stockedProduct, today } from './support/fixtures';
import { WEB as BASE } from './support/env';
import en from '../src/i18n/locales/en.json';

const EMAIL = 'abdallah@motoparts.com';
const PASSWORD = 'password123';

async function login(page: Page) {
  await page.goto(`${BASE}/en/login`);
  await page.getByPlaceholder('name@company.com').fill(EMAIL);
  await page.getByPlaceholder('StrongPassword@123').fill(PASSWORD);
  await page.getByRole('button', { name: /login/i }).click();
  await expect(page).toHaveURL(/dashboard/, { timeout: 10000 });
}

async function aCycle(request: APIRequestContext) {
  const { headers, mk } = await apiCtx(request);
  const cycle = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'EGP' });

  // Only people who can hold a share.
  //
  // This returned every user and the tests took the first, which once the
  // storefront existed was whichever shop had signed up most recently — a
  // state the business does not recognise, and one the server now refuses.
  // Two of these tests expect a 400 for an unrelated reason, so a shop account
  // here would have had them passing for the wrong one.
  const body = await (await request.get(`${API}/users?limit=100`, { headers })).json();
  const all: any[] = body.data?.items ?? body.data ?? body;
  const users = all.filter(
    (u) => u.status === 'ACTIVE' && (u.role === 'CORE_PARTNER' || u.role === 'TEMP_INVESTOR'),
  );
  expect(users.length, 'the seed has nobody who can be a cycle participant').toBeGreaterThan(0);

  return { headers, mk, cycle, users };
}

/**
 * A cycle that ran its course and closed. Since 2026-10-27 (§1, Preparing) a
 * cycle cannot pass Purchasing with nothing ordered, and one that ordered
 * something cannot settle while its goods are unaccounted for — so it is built
 * the way the business closes one: ordered, shipped, received, then settled.
 */
async function aClosedCycle(request: APIRequestContext, label: string) {
  const { headers, mk } = await apiCtx(request);
  const { cycle } = await stockedProduct(request, headers, mk, `${label} ${Date.now()}`, 1);
  const rest = ['VERIFICATION', 'SELLING', 'SETTLEMENT', 'CLOSED'];
  for (const status of rest) {
    const now = (await (await request.get(`${API}/cycles/${cycle.id}`, { headers })).json()).data.status;
    if (rest.indexOf(now) >= rest.indexOf(status)) continue;
    await mk(`cycles/${cycle.id}/transition`, { status });
  }
  return cycle as { id: string; code: string };
}

test.describe('Cycle details', () => {
  test('TC-CYC-D1: a cycle in any status opens its details', async ({ page, request }) => {
    const { cycle } = await aCycle(request);
    await login(page);
    await page.goto(`${BASE}/en/cycles/${cycle.id}/details`);
    await expect(page.getByRole('heading', { name: cycle.code })).toBeVisible({ timeout: 15000 });
  });

  test('TC-CYC-D2: a closed cycle is still readable', async ({ page, request }) => {
    // The point of the complaint. History is exactly what you want to reread.
    const cycle = await aClosedCycle(request, 'CYC-D2');

    await login(page);
    await page.goto(`${BASE}/en/cycles/${cycle.id}/details`);
    await expect(page.getByRole('heading', { name: cycle.code })).toBeVisible({ timeout: 15000 });
    // The status badge, not the funding note that also says the cycle is closed (2026-10-18).
    await expect(page.getByTestId('cycle-status')).toHaveText(/closed/i);

    // Readable, not editable: a closed cycle is history. Since 2026-10-18 the
    // funding controls stay on screen, switched off, and say why (§8).
    await expect(page.getByTestId('funding-card').getByRole('button', { name: en.fundingCard.addInvestor })).toBeDisabled();
    await expect(page.getByTestId('funding-locked')).toBeVisible();
  });

  test('TC-CYC-D3: a participant can be added, which nothing could do before', async ({
    page,
    request,
  }) => {
    // The three partners are already on a new cycle, so the one worth adding
    // by hand is a temporary investor — and a partner cannot be added twice,
    // which the unique constraint enforces.
    const { headers, cycle, users } = await aCycle(request);
    const before = (
      await (await request.get(`${API}/cycles/${cycle.id}`, { headers })).json()
    ).data.participants.length;

    await login(page);
    await page.goto(`${BASE}/en/cycles/${cycle.id}/details`);
    await page.getByTestId('funding-card').getByRole('button', { name: en.fundingCard.addInvestor }).click();

    const type = page
      .locator('input[type="hidden"][name="participantType"]')
      .locator('..')
      .getByRole('combobox');
    await type.click();
    await page.getByRole('listbox').getByRole('option').filter({ hasText: /investor/i }).first().click();

    const person = page
      .locator('input[type="hidden"][name="userId"]')
      .locator('..')
      .getByRole('combobox');
    await person.click();
    await page.getByRole('listbox').getByRole('option').first().click();

    await page.getByTestId('add-participant-form').locator('input[inputmode="decimal"]').first().fill('40000');
    await page.getByRole('button', { name: /save/i }).click();

    await expect
      .poll(async () => {
        const res = await request.get(`${API}/cycles/${cycle.id}`, { headers });
        return ((await res.json()).data?.participants ?? []).length;
      }, { timeout: 15000 })
      .toBe(before + 1);

    // And the person is named, not a dash.
    await expect(page.getByText(users[0].partner?.displayName ?? users[0].email).first()).toBeVisible();
  });

  test('TC-CYC-D4: the cycle payload never carries a password hash', async ({ request }) => {
    // Including the participant's User relation whole sent every partner's
    // bcrypt hash to the browser alongside the cycle.
    // A new cycle already carries the partners, so there is a User relation on
    // the payload without adding anything.
    const { headers, cycle } = await aCycle(request);

    const res = await request.get(`${API}/cycles/${cycle.id}`, { headers });
    const body = await res.text();
    expect(body).not.toContain('passwordHash');
    expect(body).not.toContain('$2b$');
  });

  test('TC-CYC-D5: a closed cycle refuses a new participant at the API too', async ({
    request,
  }) => {
    // The button is hidden, which is not the same as the rule existing.
    const { headers, users } = await aCycle(request);
    const cycle = await aClosedCycle(request, 'CYC-D5');

    const res = await request.post(`${API}/cycles/${cycle.id}/participants`, {
      headers,
      data: {
        participantType: 'CORE_PARTNER',
        partnerUserId: users[0].id,
        contributionAmount: 1000,
      },
    });
    expect(res.status()).toBe(400);
    expect(JSON.stringify(await res.json())).toMatch(/closed/i);
  });

  test('TC-CYC-D6: a contribution cannot be negative', async ({ request }) => {
    const { headers, cycle, users } = await aCycle(request);
    const res = await request.post(`${API}/cycles/${cycle.id}/participants`, {
      headers,
      data: {
        participantType: 'CORE_PARTNER',
        partnerUserId: users[0].id,
        contributionAmount: -5000,
      },
    });
    expect(res.status()).toBe(400);
  });
});

test.describe('The three partners fund a cycle equally by default', () => {
  test('TC-CYC-D7: a new cycle starts with the core partners on it', async ({ request }) => {
    // Every cycle used to begin with nobody on it, so settling reported "No
    // participants found" and the common case took the most work.
    const { headers, mk } = await apiCtx(request);
    const cycle = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'EGP' });

    const res = await request.get(`${API}/cycles/${cycle.id}`, { headers });
    const participants = (await res.json()).data.participants ?? [];

    const users = await (await request.get(`${API}/users?role=CORE_PARTNER&limit=100`, { headers })).json();
    const corePartners = (users.data ?? users).filter((u: any) => u.role === 'CORE_PARTNER');

    expect(participants).toHaveLength(corePartners.length);
    expect(participants.every((p: any) => p.participantType === 'CORE_PARTNER')).toBe(true);
    // Zero until the cycle's cost is known — not a guess at what they put in.
    expect(participants.every((p: any) => Number(p.contributionAmount) === 0)).toBe(true);
  });

  test('TC-CYC-D8: naming participants explicitly overrides the default', async ({ request }) => {
    // Otherwise a cycle with one named investor would quietly gain three
    // partners as well.
    const { headers, mk } = await apiCtx(request);
    // A core partner, because that is the type this names. `anInvestorUser`
    // prefers the seeded temporary investor, and only a core partner can be
    // added as one — the rule this test is not about.
    const first = await aCorePartnerUser(request, headers);

    const cycle = await mk('cycles', {
      originType: 'UAE_DIRECT',
      currency: 'EGP',
      participants: [
        { participantType: 'CORE_PARTNER', partnerUserId: first.id, contributionAmount: 5000 },
      ],
    });

    const res = await request.get(`${API}/cycles/${cycle.id}`, { headers });
    expect((await res.json()).data.participants).toHaveLength(1);
  });

  test('TC-CYC-D9: splitting equally divides the cost to the piastre', async ({ page, request }) => {
    // Thirds of a real cycle cost do not divide evenly. Left uneven, capital
    // returned at settlement would not match capital put in.
    const { headers, mk } = await apiCtx(request);
    const stamp = Date.now();
    const product = await mk('products', { name: `Split Part ${stamp}`, minStock: 0 });
    const supplier = await mk('suppliers', { name: `Split Sup ${stamp}`, country: 'AE' });
    const cycle = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'EGP' });

    // 10,000 of goods and 1.00 of shipping: 10,000.50 does not divide by three.
    await mk(`cycles/${cycle.id}/purchases`, {
      supplierId: supplier.id, currency: 'EGP', fxRateToEgp: 1, orderedOn: today(),
      items: [{ productId: product.id, orderedQty: 100, unitPrice: 100 }],
    });
    await mk(`cycles/${cycle.id}/shipping-legs`, {
      sequence: 1, origin: 'Dubai, UAE', destination: 'Cairo, Egypt',
      provider: 'Split Freight', costBasis: 'FLAT', amount: 0.5, currency: 'EGP', fxRateToEgp: 1,
    });

    await login(page);
    await page.goto(`${BASE}/en/cycles/${cycle.id}/details`);
    // The Funding card's Contributions (owner 2026-10-26).
    await page.getByTestId('funding-card').getByTestId('split-equally').click();

    await expect
      .poll(async () => {
        const res = await request.get(`${API}/cycles/${cycle.id}`, { headers });
        const ps = (await res.json()).data.participants ?? [];
        return ps.reduce((sum: number, p: any) => sum + Number(p.contributionAmount), 0);
      }, { timeout: 15000 })
      .toBe(10000.5);

    const res = await request.get(`${API}/cycles/${cycle.id}`, { headers });
    const amounts = ((await res.json()).data.participants ?? [])
      .map((p: any) => Number(p.contributionAmount))
      .sort((a: number, b: number) => a - b);

    // Within a piastre of each other, and summing exactly.
    expect(amounts[amounts.length - 1] - amounts[0]).toBeLessThanOrEqual(0.01);
  });

  test('TC-CYC-D10: an investor\'s money is not split among the partners', async ({
    page,
    request,
  }) => {
    // A temporary investor puts in a specific amount that is theirs. Sharing
    // the whole cycle cost across the partners as well would count it twice.
    const { headers, mk } = await apiCtx(request);
    const stamp = Date.now();
    const product = await mk('products', { name: `Inv Split Part ${stamp}`, minStock: 0 });
    const supplier = await mk('suppliers', { name: `Inv Split Sup ${stamp}`, country: 'AE' });
    const cycle = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'EGP' });

    await mk(`cycles/${cycle.id}/purchases`, {
      supplierId: supplier.id, currency: 'EGP', fxRateToEgp: 1, orderedOn: today(),
      items: [{ productId: product.id, orderedQty: 100, unitPrice: 100 }],
    });
    await mk(`cycles/${cycle.id}/shipping-legs`, {
      sequence: 1, origin: 'Dubai, UAE', destination: 'Cairo, Egypt',
      provider: 'Inv Freight', costBasis: 'FLAT', amount: 0, currency: 'EGP', fxRateToEgp: 1,
    });

    const investor = await anInvestorUser(request, headers);
    await mk(`cycles/${cycle.id}/participants`, {
      participantType: 'TEMP_INVESTOR',
      investorUserId: investor.id,
      contributionAmount: 4000,
      investorFeePct: 15,
    });

    await login(page);
    await page.goto(`${BASE}/en/cycles/${cycle.id}/details`);
    // The Funding card's Contributions (owner 2026-10-26).
    await page.getByTestId('funding-card').getByTestId('split-equally').click();

    // 10,000 cost, 4,000 from the investor: the partners cover the other 6,000.
    await expect
      .poll(async () => {
        const res = await request.get(`${API}/cycles/${cycle.id}`, { headers });
        const ps = (await res.json()).data.participants ?? [];
        return ps
          .filter((p: any) => p.participantType === 'CORE_PARTNER')
          .reduce((sum: number, p: any) => sum + Number(p.contributionAmount), 0);
      }, { timeout: 15000 })
      .toBe(6000);

    // And the investor's own contribution is untouched.
    const res = await request.get(`${API}/cycles/${cycle.id}`, { headers });
    const inv = ((await res.json()).data.participants ?? []).find(
      (p: any) => p.participantType === 'TEMP_INVESTOR',
    );
    expect(Number(inv.contributionAmount)).toBe(4000);
  });
});

// Owner 2026-10-19: the Settlement button opened the Settlements tab with no
// cycle chosen, so the cycle you came from had to be found again in the picker.
test.describe('Settlement button carries its cycle', () => {
  test('TC-CYC-D-SET1: the Settlements tab opens with that cycle picked, and keeps a cycle picked there', async ({ page, request }) => {
    const { mk, cycle } = await aCycle(request);
    const other = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'EGP' });
    await login(page);
    await page.goto(`${BASE}/en/cycles/${cycle.id}/details`);
    await expect(page.getByRole('heading', { name: cycle.code })).toBeVisible({ timeout: 15000 });

    // Reached by clicking, the way a partner gets there — not by typing the address.
    await page.getByRole('main').getByRole('button', { name: /^settlement$/i }).click();
    await expect(page).toHaveURL(new RegExp(`/en/partners\?.*cycle=${cycle.id}`), { timeout: 15000 });
    const picker = page.getByRole('main').locator('#cycle-select');
    await expect(picker).toContainText(cycle.code, { timeout: 15000 });
    await expect(page.getByRole('button', { name: /calculate/i })).toBeEnabled();

    // The second time: choosing another cycle here replaces the one from the
    // address, and the address follows, so a refresh keeps it.
    await picker.click();
    await page.getByRole('option', { name: new RegExp(other.code) }).click();
    await expect(picker).toContainText(other.code);
    await expect(page).toHaveURL(new RegExp(`cycle=${other.id}`));
    await page.reload();
    await expect(page.getByRole('main').locator('#cycle-select')).toContainText(other.code, { timeout: 15000 });
  });

  test('TC-CYC-D-SET2: an address naming a cycle that does not exist picks nothing', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/partners?view=settlements&cycle=00000000-0000-0000-0000-000000000000`);
    await expect(page.getByRole('main').locator('#cycle-select')).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole('button', { name: /calculate/i })).toBeDisabled();
  });
});
