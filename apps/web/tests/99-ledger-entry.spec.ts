/* eslint-disable @typescript-eslint/no-explicit-any -- API responses are parsed JSON; each assertion names the field it checks */
/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: L6 — a manual ledger entry that can't lie
 * ═══════════════════════════════════════════════════════════════════════
 *  BUSINESS_LOGIC §9 (owner, mockup accepted 2026-10-11). "Record money in or
 *  out": two kind cards that set the direction, a category from the one list,
 *  the shared currency/rate, a date that cannot be in the future, an optional
 *  cycle that extra freight requires, a note.
 *
 *  Every flow reaches the ledger through the menu (CLAUDE.md §2). The rules'
 *  own tests: apps/api/src/modules/ledger/ledger-entry.spec.ts, the Vitest
 *  beside the dialog, and the money invariants in 34 (TC-INV-54..58).
 *
 *  `L6_SHOTS=1` also writes the review screenshots to .ui-audit/l6/.
 */
import { test, expect, type Page } from '@playwright/test';
import { API, apiCtx } from './support/fixtures';
import { psqlStdin } from './support/database';
import { leftoverWorld } from './support/leftovers';
import { BASE, day, login, messages, pickDate, type Locale } from './support/ui';

const SHOTS = process.env.L6_SHOTS === '1';
const SHOT_DIR = '../../.ui-audit/l6';
const en = messages('en');

async function hideDevBadge(page: Page) {
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
}

/** Menu → Ledger, as a person gets there. */
async function openLedger(page: Page, locale: Locale = 'en') {
  const phone = (page.viewportSize()?.width ?? 1440) < 768;
  if (phone) {
    await hideDevBadge(page);
    await page.locator('button:has(svg.lucide-menu)').filter({ visible: true }).first().click();
    await page.locator(`a[href="/${locale}/ledger"]`).filter({ visible: true }).first().click();
  } else {
    await page.locator(`aside a[href="/${locale}/ledger"]`).filter({ visible: true }).first().click();
  }
  await expect(page).toHaveURL(new RegExp(`/${locale}/ledger$`), { timeout: 15000 });
  await expect(page.getByRole('heading', { name: messages(locale).ledger.title })).toBeVisible();
}

const dialog = (page: Page) => page.locator('[data-ledger-entry-dialog]');

async function openNewEntry(page: Page, locale: Locale = 'en') {
  await page.getByRole('button', { name: messages(locale).ledger.create }).first().click();
  await expect(dialog(page)).toBeVisible();
}

async function pick(page: Page, id: string, option: RegExp | string) {
  await dialog(page).locator(`#${id}`).click();
  await page.getByRole('option', { name: option }).first().click();
}

async function fill(page: Page, opts: { kind?: 'EXPENSE' | 'OTHER_INCOME'; category: string; amount: string; note?: string; locale?: Locale }) {
  const m = messages(opts.locale ?? 'en');
  const d = dialog(page);
  await d.getByRole('radio', { name: new RegExp(opts.kind === 'OTHER_INCOME' ? m.ledger.kindIncome : m.ledger.kindExpense) }).click();
  await pick(page, 'ledger-category', new RegExp(`^${esc((m.codes as any).ledgerCategory[opts.category])}$`));
  await d.locator('#ledger-amount').fill(opts.amount);
  if (opts.note) await d.locator('#ledger-note').fill(opts.note);
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const save = (page: Page, locale: Locale = 'en') =>
  dialog(page).getByRole('button', { name: messages(locale).common.save, exact: true }).click();

/** The list narrowed to one entry by its note, which the search reads. */
async function findRow(page: Page, note: string) {
  await page.getByPlaceholder(en.ledger.search).fill(note);
  return page.locator('table tbody tr').filter({ visible: true });
}

const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: `${SHOT_DIR}/${name}.png`, fullPage: true });
};

test.describe('Record money in or out (L6)', () => {
  test('TC-L6-01: an expense — the card sets money out, the category is from the list, the date is the day it happened', async ({ page, request }) => {
    const note = `L6-01 ${Date.now()}`;
    await login(page);
    await openLedger(page);
    await openNewEntry(page);
    await fill(page, { category: 'rent', amount: '1500', note });
    await pickDate(page, 'occurredOn', day(-3));
    await save(page);
    await expect(dialog(page)).toHaveCount(0);

    const row = await findRow(page, note);
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(en.codes.ledgerCategory.rent);
    await expect(row).toContainText(en.ledger.outflow);
    await expect(row).toContainText('1,500.00');

    const { headers } = await apiCtx(request);
    const saved = ((await (await request.get(`${API}/ledger?limit=50`, { headers })).json()).data as any[]).find((r) => r.reason === note);
    expect(saved).toMatchObject({ type: 'EXPENSE', category: 'rent', direction: 'OUTFLOW', cycleId: null });
    expect(saved.occurredOn.slice(0, 10)).toBe(day(-3));
  });

  test('TC-L6-02: other income — the card sets money in; only the income list is offered', async ({ page }) => {
    const note = `L6-02 ${Date.now()}`;
    await login(page);
    await openLedger(page);
    await openNewEntry(page);
    await dialog(page).getByRole('radio', { name: new RegExp(en.ledger.kindIncome) }).click();
    await dialog(page).locator('#ledger-category').click();
    await expect(page.getByRole('option')).toHaveCount(3);
    await expect(page.getByRole('option', { name: en.codes.ledgerCategory.rent })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await fill(page, { kind: 'OTHER_INCOME', category: 'interest', amount: '250', note });
    await save(page);
    await expect(dialog(page)).toHaveCount(0);
    const row = await findRow(page, note);
    await expect(row).toContainText(en.codes.ledgerCategory.interest);
    await expect(row).toContainText(en.ledger.inflow);
  });

  test('TC-L6-03: extra freight is refused without its cycle, then charged to it — and the cycle page shows it', async ({ page, request }) => {
    const { a } = await leftoverWorld(request, 'L6 Freight');
    const note = `L6-03 ${Date.now()}`;
    await login(page);
    await openLedger(page);
    await openNewEntry(page);
    await fill(page, { category: 'extra_freight', amount: '300', note });
    await expect(dialog(page)).toContainText(en.ledger.cycleRequiredHint);
    await save(page);
    // Seen where it is, not somewhere below the fold.
    await expect(page.getByTestId('ledger-refusal')).toBeInViewport();
    await expect(page.getByTestId('ledger-refusal')).toHaveText(
      en.errors.LEDGER_CYCLE_REQUIRED.replace('{category}', en.codes.ledgerCategory.extra_freight),
    );
    // Closed and cancelled cycles are not offered; this one is selling.
    await pick(page, 'ledger-cycle', new RegExp(`${a.code} · ${en.codes.cycleStatus.SELLING}`));
    await save(page);
    await expect(dialog(page)).toHaveCount(0);
    await expect(await findRow(page, note)).toContainText(a.code);

    // Menu → Cycles → its page: 1,000 of profit less 300.
    await page.locator('aside a[href="/en/cycles"]').filter({ visible: true }).first().click();
    await page.getByRole('main').getByPlaceholder(en.cycles.search).fill(a.code);
    await page.getByRole('main').getByTestId('cycle-row').filter({ hasText: a.code }).locator('td').first().click();
    await expect(page).toHaveURL(new RegExp(`/cycles/${a.id}/details$`), { timeout: 15000 });
    await expect(page.getByTestId('cycle-profit-expenses')).toHaveText(/300\.00/);
    await expect(page.getByTestId('cycle-profit-value')).toHaveText(/700\.00/);
  });

  test('TC-L6-04: a foreign amount — the rate comes from the FX page, a typed one stays, and pounds are what is stored', async ({ page, request }) => {
    const note = `L6-04 ${Date.now()}`;
    const { headers } = await apiCtx(request);
    const rates = (await (await request.get(`${API}/currency-rates/map`, { headers })).json()).data;
    await login(page);
    await openLedger(page);
    await openNewEntry(page);
    await fill(page, { category: 'bank_fees', amount: '10', note });
    const rate = dialog(page).locator('input[name="fxRateToEgp"]:not([type="hidden"])');
    await expect(rate).toHaveCount(0); // pounds: no rate to ask
    await dialog(page).getByRole('combobox').filter({ hasText: 'EGP' }).click();
    await page.getByRole('option', { name: /^USD/ }).click();
    await expect(rate).toHaveValue(String(rates.USD));
    await rate.fill('50');
    await page.waitForTimeout(500);
    await expect(rate).toHaveValue('50');
    await save(page);
    await expect(dialog(page)).toHaveCount(0);
    const row = await findRow(page, note);
    await expect(row).toContainText('500.00');
    await row.getByTitle(en.common.view).click();
    await expect(page.getByText(en.ledger.originalAmount)).toBeVisible();
  });

  test('TC-L6-05: undo an expense, and open the form again — it is clean', async ({ page }) => {
    const note = `L6-05 ${Date.now()}`;
    await login(page);
    await openLedger(page);
    await openNewEntry(page);
    await fill(page, { category: 'marketing', amount: '400', note });
    await save(page);
    await expect(dialog(page)).toHaveCount(0);
    const row = await findRow(page, note);
    await row.getByTitle(en.ledger.reverse).click();
    await page.locator('textarea[name="reason"]').fill('entered by mistake');
    await page.getByRole('button', { name: en.ledger.reverse }).last().click();
    // The reversal carries the reason as its note; the original keeps its own.
    await page.getByPlaceholder(en.ledger.search).fill('entered by mistake');
    await expect(page.locator('table tbody tr').filter({ visible: true }).filter({ hasText: en.codes.ledgerCategory.marketing }).first()).toContainText(en.ledger.inflow);

    await page.getByPlaceholder(en.ledger.search).fill('');
    await openNewEntry(page);
    await expect(dialog(page).getByRole('radio', { name: new RegExp(en.ledger.kindExpense) })).toHaveAttribute('aria-checked', 'true');
    await expect(dialog(page).locator('input[type="hidden"][name="category"]')).toHaveValue('');
    await expect(dialog(page).locator('#ledger-amount')).toHaveValue('');
    await expect(dialog(page).locator('#ledger-note')).toHaveValue('');
  });

  test('TC-L6-06: the category filter reads the one list; an old free-text row still shows, as written', async ({ page, request }) => {
    const stamp = Date.now();
    const { headers } = await apiCtx(request);
    // A row written before L6, by the old form: free text, no date of its own.
    psqlStdin(`INSERT INTO financial_transactions (id, type, category, direction, amount, currency, reason, created_at)
      VALUES (gen_random_uuid(), 'EXPENSE', 'Office chairs ${stamp}', 'OUTFLOW', 800, 'EGP', 'legacy ${stamp}', now());`);
    const rentNote = `L6-06 ${stamp}`;
    const res = await request.post(`${API}/ledger`, { headers, data: { kind: 'EXPENSE', category: 'rent', amount: 100, currency: 'EGP', note: rentNote } });
    expect(res.status(), await res.text()).toBe(201);

    await login(page);
    await openLedger(page);
    const legacy = await findRow(page, `legacy ${stamp}`);
    await expect(legacy).toContainText(`Office chairs ${stamp}`);
    await page.getByPlaceholder(en.ledger.search).fill('');

    const filter = page.getByRole('combobox').filter({ hasText: en.ledger.allCategories });
    await filter.click();
    for (const c of ['rent', 'extra_freight', 'interest'] as const) {
      await expect(page.getByRole('option', { name: new RegExp(`^${esc(en.codes.ledgerCategory[c])}`) }).first()).toBeVisible();
    }
    await page.getByRole('option', { name: new RegExp(`^${en.codes.ledgerCategory.rent}`) }).first().click();
    const rows = page.locator('table tbody tr').filter({ visible: true });
    await expect(rows.first()).toContainText(en.codes.ledgerCategory.rent);
    expect(await rows.filter({ hasNotText: en.codes.ledgerCategory.rent }).count()).toBe(0);
  });

  test('TC-L6-07: a refusal from the server keeps the form, in the reader’s language (Arabic)', async ({ page, request }) => {
    const { mk } = await apiCtx(request);
    const shut = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'EGP' });
    await login(page, 'ar');
    await openLedger(page, 'ar');
    await openNewEntry(page, 'ar');
    await fill(page, { category: 'rent', amount: '300', locale: 'ar' });
    // Chosen while still planning, then cancelled behind the form's back.
    await pick(page, 'ledger-cycle', new RegExp(shut.code));
    await mk(`cycles/${shut.id}/transition`, { status: 'CANCELLED' });
    await save(page, 'ar');
    const ar = messages('ar');
    await expect(page.getByTestId('ledger-refusal')).toHaveText(
      ar.errors.LEDGER_CYCLE_NOT_OPEN.replace('{cycle}', shut.code).replace('{status}', ar.codes.cycleStatus.CANCELLED),
    );
    await expect(dialog(page).locator('#ledger-amount')).toHaveValue('300');
  });
});

// ─── Review screenshots (L6_SHOTS=1) ─────────────────────────────────────

test.describe('Screenshots', () => {
  test.skip(!SHOTS, 'L6_SHOTS=1 to write them');
  for (const locale of ['en', 'ar'] as const) {
    for (const width of [1440, 390]) {
      test(`TC-L6-SHOT ${locale} ${width}`, async ({ page, request }) => {
        test.setTimeout(180_000);
        const m = messages(locale);
        const tag = `${locale}-${width}`;
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        const { a, headers } = await leftoverWorld(request, `L6 Shot ${tag}`);
        await request.post(`${API}/ledger`, { headers, data: { kind: 'EXPENSE', category: 'extra_freight', amount: 300, currency: 'EGP', cycleId: a.id, note: `shot ${tag}` } });
        await request.post(`${API}/ledger`, { headers, data: { kind: 'OTHER_INCOME', category: 'interest', amount: 50, currency: 'EGP', cycleId: a.id } });
        await request.post(`${API}/ledger`, { headers, data: { kind: 'EXPENSE', category: 'bank_fees', amount: 10, currency: 'USD', fxRateToEgp: 50 } });
        await login(page, locale);
        await hideDevBadge(page);
        await openLedger(page, locale);
        await shot(page, `ledger-list-${tag}`);

        await openNewEntry(page, locale);
        await shot(page, `entry-expense-${tag}`);
        await dialog(page).getByRole('radio', { name: new RegExp(m.ledger.kindIncome) }).click();
        await dialog(page).locator('#ledger-category').click();
        await page.waitForTimeout(300); // the cards' colour transition, so the shot is not mid-swap
        await shot(page, `entry-income-categories-${tag}`);
        await page.keyboard.press('Escape');
        await dialog(page).getByRole('radio', { name: new RegExp(m.ledger.kindExpense) }).click();
        await fill(page, { category: 'extra_freight', amount: '300', locale });
        await save(page, locale);
        await expect(page.getByTestId('ledger-refusal')).toBeInViewport();
        await shot(page, `entry-freight-refused-${tag}`);
        await dialog(page).getByRole('combobox').filter({ hasText: 'EGP' }).click();
        await page.getByRole('option', { name: /^USD/ }).click();
        await shot(page, `entry-usd-${tag}`);
        await dialog(page).locator('#ledger-cycle').click();
        await shot(page, `entry-cycles-${tag}`);
        await page.keyboard.press('Escape');
        await page.keyboard.press('Escape');
        await expect(dialog(page)).toHaveCount(0);

        await page.getByRole('combobox').filter({ hasText: m.ledger.allCategories }).click();
        await shot(page, `ledger-category-filter-${tag}`);
        await page.keyboard.press('Escape');

        await page.goto(`${BASE}/${locale}/cycles/${a.id}/details`);
        await hideDevBadge(page);
        await page.getByTestId('cycle-profit-card').scrollIntoViewIfNeeded();
        await expect(page.getByTestId('cycle-profit-expenses')).toBeVisible();
        await shot(page, `cycle-profit-${tag}`);
      });
    }
  }
});
