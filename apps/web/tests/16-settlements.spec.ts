/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: Settlements — cycle profit, investor fee, payouts
 * ═══════════════════════════════════════════════════════════════════════
 *  Covers BRD §8: profit follows contribution, capital and profit settle
 *  separately, and a temporary investor's fee comes out of their profit.
 */
import { test, expect, Page } from '@playwright/test';

const BASE = 'http://localhost:3000';
const API = 'http://localhost:3001/api/v1';
const EMAIL = 'partner.a@motoparts.com';
const PASSWORD = 'password123';

async function login(page: Page) {
  await page.goto(`${BASE}/en/login`);
  await page.getByPlaceholder('partner.a@motoparts.com').fill(EMAIL);
  await page.getByPlaceholder('••••••••').fill(PASSWORD);
  await page.getByRole('button', { name: /login/i }).click();
  await expect(page).toHaveURL(/dashboard/, { timeout: 10000 });
}

async function token(request: any) {
  const auth = await request.post(`${API}/auth/login`, {
    data: { email: EMAIL, password: PASSWORD },
  });
  return (await auth.json()).data.accessToken;
}

/** Read a money cell like "50,000.00 EGP" as a number. */
const money = (text: string | null) =>
  Number((text ?? '').replace(/[^0-9.-]/g, ''));


/**
 * Pick a cycle from the searchable Select.
 *
 * The picker is no longer a native <select>, so selectOption() does not apply.
 * Open it, type enough to filter, then click the row — which is also what a
 * user does, so the test exercises the real interaction.
 */
async function pickCycle(page: Page, code: string) {
  await page.locator('#cycle-select').click();
  const list = page.getByRole('listbox');
  await list.waitFor({ state: 'visible' });

  // The Select only shows a search box once the list is long enough to need
  // one, so a short list has none — and reaching for a "search" placeholder
  // then finds the page's own search field and types into that instead.
  const search = list.locator('[cmdk-input]');
  if (await search.count()) {
    await search.fill(code);
  }

  await list.getByRole('option', { name: new RegExp(code) }).first().click();
  await expect(page.locator('#cycle-select')).toContainText(code);
}

test.describe('Settlements', () => {
  test('TC-SET-01: Settlements page loads', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/settlements`);
    await expect(page.getByRole('heading', { name: /settlements/i })).toBeVisible();
  });

  test('TC-SET-02: Cycle picker lists every cycle, not just the first page', async ({ page, request }) => {
    await login(page);

    // Compare the picker against the API rather than a fixed count: the point
    // is that nothing is truncated at the default page size, and that has to
    // hold whether the database has two cycles or two hundred.
    const t = await token(request);
    const res = await request.get(`${API}/cycles?limit=200`, {
      headers: { Authorization: `Bearer ${t}` },
    });
    const total = ((await res.json()).data ?? []).length;

    await page.goto(`${BASE}/en/settlements`);
    await page.locator('#cycle-select').click();
    const options = page.getByRole('listbox').getByRole('option');
    // The custom picker has no placeholder row, so the counts match exactly.
    await expect.poll(() => options.count(), { timeout: 10000 }).toBe(total);
  });

  test('TC-SET-03: Calculating a cycle shows its profit and loss', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/settlements`);

    await pickCycle(page, 'CYC-DEMO-001');
    await page.getByRole('button', { name: /calculate/i }).click();

    const card = page.locator('div').filter({ hasText: /CYC-DEMO-001/ }).first();
    await expect(page.getByText('Revenue').first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('COGS').first()).toBeVisible();
    await expect(page.getByText(/Profit/).first()).toBeVisible();
    expect(await card.count()).toBeGreaterThan(0);
  });

  test('TC-SET-04: Capital and profit are shown as separate columns', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/settlements`);
    await expect(page.getByRole('columnheader', { name: /capital/i }).first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole('columnheader', { name: /profit/i }).first()).toBeVisible();
    await expect(page.getByRole('columnheader', { name: /payout/i }).first()).toBeVisible();
  });

  test('TC-SET-05: Payout equals capital plus net profit plus fee received', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/settlements`);
    await pickCycle(page, 'CYC-DEMO-001');
    await page.getByRole('button', { name: /calculate/i }).click();
    await page.waitForTimeout(1500);

    const rows = page.locator('table tbody tr');
    const n = await rows.count();
    expect(n).toBeGreaterThan(0);

    for (let i = 0; i < n; i++) {
      const cells = rows.nth(i).locator('td');
      if ((await cells.count()) < 5) continue;
      const capital = money(await cells.nth(1).textContent());
      const profit = money(await cells.nth(2).textContent());
      const feeText = (await cells.nth(3).textContent()) ?? '';
      const fee = feeText.includes('—') ? 0 : money(feeText);
      const payout = money(await cells.nth(4).textContent());

      // A negative fee is the investor's own deduction, already inside the
      // net profit; only a received fee adds to the payout.
      const expected = capital + profit + (fee > 0 ? fee : 0);
      expect(Math.abs(payout - expected)).toBeLessThan(0.02);
    }
  });

  test('TC-SET-06: Unsold stock is flagged and excluded from profit', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/settlements`);
    await pickCycle(page, 'CYC-DEMO-001');
    await page.getByRole('button', { name: /calculate/i }).click();
    await expect(
      page.getByText(/still in stock/i).first(),
    ).toBeVisible({ timeout: 10000 });
  });

  test('TC-SET-07: API — profit equals revenue minus COGS minus expenses', async ({ request }) => {
    const auth = await request.post(`${API}/auth/login`, {
      data: { email: EMAIL, password: PASSWORD },
    });
    const token = (await auth.json()).data.accessToken;

    const cycles = await request.get(`${API}/cycles?limit=200`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const cycle = (await cycles.json()).data.find((c: any) => c.code === 'CYC-DEMO-001');
    expect(cycle).toBeTruthy();

    const res = await request.post(`${API}/settlements/calculate/${cycle.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.ok()).toBeTruthy();

    const { summary } = await res.json();
    const revenue = Number(summary.revenueEgp);
    const cogs = Number(summary.cogsEgp);
    const expenses = Number(summary.expensesEgp);
    const profit = Number(summary.grossProfitEgp);

    expect(Math.abs(profit - (revenue - cogs - expenses))).toBeLessThan(0.01);
    // Capital is returned on top of profit, never mixed into it.
    expect(Number(summary.totalPayout)).toBeCloseTo(
      Number(summary.capitalReturned) + profit,
      2,
    );
  });

  test('TC-SET-08: API — an investor fee never touches capital', async ({ request }) => {
    const auth = await request.post(`${API}/auth/login`, {
      data: { email: EMAIL, password: PASSWORD },
    });
    const token = (await auth.json()).data.accessToken;
    const headers = { Authorization: `Bearer ${token}` };

    const list = await request.get(`${API}/settlements?limit=200`, { headers });
    const settlements = (await list.json()).data;
    const withInvestor = settlements.find((s: any) =>
      s.lines?.some((l: any) => l.component === 'INVESTOR_FEE'),
    );
    test.skip(!withInvestor, 'No settlement with a temporary investor');

    const lines = withInvestor.lines;
    const feeLine = lines.find((l: any) => l.component === 'INVESTOR_FEE');
    const investorId = feeLine.participant.id;

    const capital = lines.find(
      (l: any) => l.participant.id === investorId && l.component === 'CAPITAL_RETURN',
    );
    // The investor gets every unit of capital back; the fee comes off profit.
    expect(Number(capital.amount)).toBeGreaterThan(0);

    const fee = Math.abs(Number(feeLine.amount));
    const received = lines
      .filter((l: any) => l.component === 'INVESTOR_FEE_RECEIVED')
      .reduce((s: number, l: any) => s + Number(l.amount), 0);
    expect(Math.abs(received - fee)).toBeLessThan(0.02);
  });
});

test.describe('Settlement actions from the page', () => {
  /** Approve a settlement for a cycle that has sales, so Mark paid is on screen. */
  async function approvedSettlement(request: any, h: any) {
    const profitability = (await (
      await request.get(`${API}/analytics/cycle-profitability`, { headers: h })
    ).json()).data;
    const target = profitability.find(
      (c: any) => c.status !== 'CLOSED' && Number(c.totalRevenue) > 0,
    );
    if (!target) return null;

    const cycles = (await (await request.get(`${API}/cycles?limit=200`, { headers: h })).json()).data;
    const cycle = cycles.find((c: any) => c.code === target.cycleCode);
    if (!cycle) return null;

    const settlement = (await (
      await request.post(`${API}/settlements/calculate/${cycle.id}`, { headers: h })
    ).json()).data;
    await request.post(`${API}/settlements/${settlement.id}/approve`, { headers: h });
    return settlement;
  }

  test('TC-SET-15: Mark paid sends the body /pay accepts', async ({ page, request }) => {
    const h = { Authorization: `Bearer ${await token(request)}` };
    const settlement = await approvedSettlement(request, h);
    test.skip(!settlement, 'no open cycle with sales to settle');

    await login(page);
    await page.goto(`${BASE}/en/settlements`);

    const payButton = page.getByRole('button', { name: /mark paid/i }).first();
    await expect(payButton).toBeVisible({ timeout: 15000 });

    const call = page.waitForResponse((r) => r.url().includes('/pay') && r.request().method() === 'POST');
    await payButton.click();
    const response = await call;

    // One mutation used to serve approve, pay and reverse alike, posting
    // `{ reason }` to all three. /pay whitelists only acceptRemainingStock, so
    // every Mark paid died on "property reason should not exist".
    const sent = JSON.parse(response.request().postData() || '{}');
    expect(sent.reason).toBeUndefined();
    expect(JSON.stringify(await response.json())).not.toMatch(/should not exist/i);

    // It either paid, or it asked about stock still on the shelf — never a
    // dead-end validation error.
    await expect(
      page.getByText(/Settlement paid/i).or(page.getByRole('button', { name: /close anyway/i })).first(),
    ).toBeVisible({ timeout: 10000 });

    // Amounts the API writes into a message are read by people too: they carry
    // thousands separators like every amount the UI renders itself.
    const body = await page.textContent('body');
    expect(body).not.toMatch(/\b\d{5,}\.\d{2}\s*EGP/);

    // Leave the cycle as it was found.
    await request.post(`${API}/settlements/${settlement!.id}/reverse`, {
      headers: h, data: { reason: 'Reopened after a settlement check' },
    });
  });

  test('TC-SET-16: reversing asks for a reason instead of inventing one', async ({ page, request }) => {
    const h = { Authorization: `Bearer ${await token(request)}` };
    const settlement = await approvedSettlement(request, h);
    test.skip(!settlement, 'no open cycle with sales to settle');

    await login(page);
    await page.goto(`${BASE}/en/settlements`);

    const reverseButton = page.getByRole('button', { name: /^reverse$/i }).first();
    await expect(reverseButton).toBeVisible({ timeout: 15000 });
    await reverseButton.click();

    // The reason lands on the balancing ledger entries and in the audit log, so
    // it has to come from the person reversing — it used to be hardcoded.
    const reason = page.getByLabel(/why is this being reversed/i);
    await expect(reason).toBeVisible();
    await reason.fill('Reopened after a settlement check');

    const call = page.waitForResponse((r) => r.url().includes('/reverse') && r.request().method() === 'POST');
    await page.getByRole('button', { name: /^reverse$/i }).last().click();
    const response = await call;

    expect(JSON.parse(response.request().postData() || '{}').reason).toBe(
      'Reopened after a settlement check',
    );
    expect(response.status()).toBeLessThan(400);
  });
});
