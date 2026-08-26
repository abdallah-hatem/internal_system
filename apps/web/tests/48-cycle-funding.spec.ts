/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: The wizard asks who is funding the cycle
 * ═══════════════════════════════════════════════════════════════════════
 *  It never used to. Contributions are seeded at zero because the cost is not
 *  known when the cycle is created, and filling them in lived on a different
 *  page — so it was a step you could finish the wizard without, weeks before
 *  settlement made it matter.
 *
 *  And it mattered a great deal. An unfunded cycle gave every participant a
 *  zero share, so every line rounded to zero except the last, which takes the
 *  rounding residual — the whole profit landed on whichever partner happened to
 *  be created last. On 90,000 across three equal partners: 0 / 0 / 90,000,
 *  silently. That refusal is covered in settlement-math.spec; this is about the
 *  step that stops anyone reaching it.
 */
import { test, expect, Page } from '@playwright/test';
import { apiCtx, API, today } from './support/fixtures';

const BASE = 'http://localhost:3000';
const EMAIL = 'partner.a@motoparts.com';
const PASSWORD = 'password123';

const num = (v: any) => Number(v ?? 0);

async function login(page: Page) {
  await page.goto(`${BASE}/en/login`);
  await page.getByPlaceholder('partner.a@motoparts.com').fill(EMAIL);
  await page.getByPlaceholder('••••••••').fill(PASSWORD);
  await page.getByRole('button', { name: /login/i }).click();
  await expect(page).toHaveURL(/dashboard/, { timeout: 10000 });
}

/** A cycle costed far enough that step 4 knows what it is worth. */
async function costedCycle(request: any, label: string) {
  const { mk, headers } = await apiCtx(request);
  const product = await mk('products', { name: `${label} Part`, minStock: 0 });
  const supplier = await mk('suppliers', { name: `${label} Supplier`, country: 'AE' });
  const provider = await mk('providers', { name: `${label} Freight` });
  const cycle = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'EGP' });

  await mk(`cycles/${cycle.id}/purchases`, {
    supplierId: supplier.id, currency: 'EGP', fxRateToEgp: 1, orderedOn: today(),
    items: [{ productId: product.id, orderedQty: 10, unitPrice: 900 }],
  });
  await mk(`cycles/${cycle.id}/shipping-legs`, {
    sequence: 1, origin: 'Dubai, UAE', destination: 'Cairo, Egypt',
    providerId: provider.id, provider: provider.name,
    costBasis: 'FLAT', amount: 1000, currency: 'EGP', fxRateToEgp: 1,
  });

  const detail = await (await request.get(`${API}/cycles/${cycle.id}`, { headers })).json();
  return { cycle, participants: (detail.data ?? detail).participants ?? [] };
}

const contributionsOf = async (request: any, cycleId: string) => {
  const { headers } = await apiCtx(request);
  const detail = await (await request.get(`${API}/cycles/${cycleId}`, { headers })).json();
  return ((detail.data ?? detail).participants ?? []).map((p: any) =>
    num(p.contributionAmount),
  );
};

test.describe('Funding in the wizard', () => {
  test('TC-FUND-01: the last step asks who funded it, and by how much', async ({
    page,
    request,
  }) => {
    const { cycle } = await costedCycle(request, `Fund${Date.now()}`);

    await login(page);
    await page.goto(`${BASE}/en/cycles/${cycle.id}`);

    await expect(page.getByText('Who is funding this cycle')).toBeVisible({
      timeout: 20000,
    });
    // One field per participant — the three partners a cycle starts with.
    await expect(page.locator('input[data-field^="contribution-"]')).toHaveCount(3);
  });

  test('TC-FUND-02: split equally covers the cycle cost exactly', async ({
    page,
    request,
  }) => {
    // Thirds rarely divide evenly. Left uneven, capital returned at settlement
    // would not match capital put in.
    const { cycle } = await costedCycle(request, `Split${Date.now()}`);

    await login(page);
    await page.goto(`${BASE}/en/cycles/${cycle.id}`);
    await expect(page.getByText('Who is funding this cycle')).toBeVisible({
      timeout: 20000,
    });

    await page.getByRole('button', { name: /split equally/i }).click();
    await page.getByRole('button', { name: /^save$/i }).click();
    await expect(page.getByText(/contributions saved/i)).toBeVisible({ timeout: 15000 });

    const amounts = await contributionsOf(request, cycle.id);
    const total = amounts.reduce((s: number, n: number) => s + n, 0);

    // Goods 9,000 plus shipping 1,000.
    expect(total).toBeCloseTo(10_000, 2);
    expect(amounts.every((n: number) => n > 0)).toBeTruthy();
    // Within a piastre of each other — the last absorbs the residual.
    // Compared in whole piastres: subtracting the floats gave
    // 0.010000000000218279, which is not a real difference.
    const cents = amounts.map((n: number) => Math.round(n * 100));
    expect(Math.max(...cents) - Math.min(...cents)).toBeLessThanOrEqual(1);
  });

  test('TC-FUND-03: saving records it against the cycle, and in the ledger', async ({
    page,
    request,
  }) => {
    // Funding is money arriving, so it belongs on the ledger too — the same
    // rule the contributions work established.
    const { cycle } = await costedCycle(request, `Ledger${Date.now()}`);
    const { headers } = await apiCtx(request);

    await login(page);
    await page.goto(`${BASE}/en/cycles/${cycle.id}`);
    await expect(page.getByText('Who is funding this cycle')).toBeVisible({
      timeout: 20000,
    });

    await page.getByRole('button', { name: /split equally/i }).click();
    await page.getByRole('button', { name: /^save$/i }).click();
    await expect(page.getByText(/contributions saved/i)).toBeVisible({ timeout: 15000 });

    const ledger = await (await request.get(`${API}/ledger?limit=200`, { headers })).json();
    const posted = (ledger.data?.items ?? ledger.data ?? [])
      .filter((r: any) => r.cycleId === cycle.id && r.category === 'contribution')
      .reduce((s: number, r: any) => s + num(r.amount), 0);

    expect(posted).toBeCloseTo(10_000, 2);
  });

  test('TC-FUND-07: participants are named, not left as dashes', async ({
    page,
    request,
  }) => {
    // `partner` and `investor` on a participant row are USER records and the
    // display name is nested one level deeper. Read a level too high it is
    // undefined for everyone, and the block rendered three identical amounts
    // against three blank rows.
    const { cycle } = await costedCycle(request, `Named${Date.now()}`);

    await login(page);
    await page.goto(`${BASE}/en/cycles/${cycle.id}`);
    await expect(page.getByText('Who is funding this cycle')).toBeVisible({
      timeout: 20000,
    });

    const block = await page.locator('main').innerText();
    expect(block).toContain('Partner A');
    expect(block).toContain('Partner B');
    expect(block).toContain('Partner C');
  });

  test('TC-FUND-08: a temporary investor can be added, with a fee', async ({
    page,
    request,
  }) => {
    // There was no way to put anyone but the three partners on a cycle from
    // the wizard — the only route was a separate page.
    const { mk, headers } = await apiCtx(request);
    const stamp = Date.now();
    const investor = await mk('users', {
      email: `investor${stamp}@motoparts.com`,
      password: 'password123',
      role: 'TEMP_INVESTOR',
      displayName: `Investor ${stamp}`,
    });
    const { cycle } = await costedCycle(request, `Inv${stamp}`);

    await login(page);
    await page.goto(`${BASE}/en/cycles/${cycle.id}`);
    await expect(page.getByText('Add a temporary investor')).toBeVisible({
      timeout: 20000,
    });

    await page
      .locator('[role="combobox"]')
      .filter({ hasText: 'Select a person' })
      .last()
      .click();
    await page
      .getByRole('listbox')
      .getByRole('option')
      .filter({ hasText: `Investor ${stamp}` })
      .first()
      .click();
    await page.locator('input[data-field="investor-amount"]').fill('2500');
    await page.locator('input[name="investorFeePct"]').fill('15');
    await page.getByRole('button', { name: /^add$/i }).click();

    await expect(page.getByText(/investor added/i)).toBeVisible({ timeout: 15000 });

    const detail = await (await request.get(`${API}/cycles/${cycle.id}`, { headers })).json();
    const added = ((detail.data ?? detail).participants ?? []).find(
      (p: any) => p.investorUserId === investor.id,
    );
    expect(added).toBeTruthy();
    expect(added.participantType).toBe('TEMP_INVESTOR');
    expect(num(added.contributionAmount)).toBeCloseTo(2500, 2);
    expect(num(added.investorFeePct)).toBeCloseTo(15, 2);

    // And the new investor gets a row of their own to fund.
    await expect(page.locator('input[data-field^="contribution-"]')).toHaveCount(4);
  });

  test('TC-FUND-04: an unfunded cycle says so rather than staying silent', async ({
    page,
    request,
  }) => {
    // Not blocking — a cycle can be funded from outside the system — but it is
    // stated, because settlement will not state it.
    const { cycle } = await costedCycle(request, `Quiet${Date.now()}`);

    await login(page);
    await page.goto(`${BASE}/en/cycles/${cycle.id}`);
    await expect(page.getByText('No contributions recorded yet')).toBeVisible({
      timeout: 20000,
    });
  });

  test('TC-FUND-05: a partial split is called out, not accepted quietly', async ({
    page,
    request,
  }) => {
    // Funding less than the cycle cost is allowed and sometimes correct. What
    // is not acceptable is it passing without comment, because the gap is
    // invisible everywhere else until settlement.
    const { cycle, participants } = await costedCycle(request, `Part${Date.now()}`);
    const { headers } = await apiCtx(request);

    await request.put(`${API}/cycles/participants/${participants[0].id}`, {
      headers,
      data: { contributionAmount: 4000 },
    });

    await login(page);
    await page.goto(`${BASE}/en/cycles/${cycle.id}`);
    await expect(page.getByText(/is not covered/i)).toBeVisible({ timeout: 20000 });
  });

  test('TC-FUND-06: an already funded cycle shows what is recorded, not blanks', async ({
    page,
    request,
  }) => {
    // Coming back to the step must not look like nothing was ever entered —
    // that invites re-entering it and doubling the capital.
    const { cycle, participants } = await costedCycle(request, `Back${Date.now()}`);
    const { headers } = await apiCtx(request);

    for (const p of participants) {
      await request.put(`${API}/cycles/participants/${p.id}`, {
        headers,
        data: { contributionAmount: 3000 },
      });
    }

    await login(page);
    await page.goto(`${BASE}/en/cycles/${cycle.id}`);
    await expect(page.getByText('Who is funding this cycle')).toBeVisible({
      timeout: 20000,
    });

    const fields = page.locator('input[data-field^="contribution-"]');
    await expect(fields.first()).toHaveValue(/3,?000/);

    // And the ledger still holds one contribution each, not two.
    const ledger = await (await request.get(`${API}/ledger?limit=200`, { headers })).json();
    const rows = (ledger.data?.items ?? ledger.data ?? []).filter(
      (r: any) => r.cycleId === cycle.id && r.category === 'contribution',
    );
    expect(rows.length).toBe(participants.length);
  });
});
