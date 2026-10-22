/* eslint-disable @typescript-eslint/no-explicit-any -- API responses are parsed JSON; each assertion names the field it checks */
/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: L7 — running costs come out of the core partners' payouts,
 *  and a payout explains itself
 * ═══════════════════════════════════════════════════════════════════════
 *  BUSINESS_LOGIC §8 (owner 2026-10-11). Rent, salaries and the like — costs
 *  with no cycle — are the core partners', equally; each partner's share comes
 *  off his next payout, on its own line. The settlement screen and the
 *  Partners page lay every payout out line by line.
 *
 *  Screens are reached through the menu (CLAUDE.md §2); cycles are built the
 *  way the business builds them (§4). The money invariants are in 34
 *  (TC-INV-59..64); the arithmetic in apps/api/src/common/running-costs.spec.ts
 *  and the service in apps/api/src/modules/settlements/running-costs.flow.spec.ts.
 *
 *  `L7_SHOTS=1` also writes the review screenshots to .ui-audit/l7/.
 */
import { test, expect, type Page } from '@playwright/test';
import { apiCtx, today } from './support/fixtures';
import {
  approved,
  cents,
  recordCost,
  runningCosts,
  settlement,
  settlementRows,
  soldOutCycle,
  usersByEmail,
  waitingFor,
} from './support/running-costs';
import { login, messages, openNav, openView, type Locale } from './support/ui';

const SHOTS = process.env.L7_SHOTS === '1';
const SHOT_DIR = '../../.ui-audit/l7';

async function hideDevBadge(page: Page) {
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
}
/**
 * The screen as it stands, and the element under review whole: the app
 * scrolls inside its main pane, so a full-page shot stops at the fold.
 */
const shot = async (page: Page, name: string, el?: ReturnType<Page['locator']>) => {
  if (!SHOTS) return;
  await hideDevBadge(page);
  await page.screenshot({ path: `${SHOT_DIR}/${name}.png` });
  if (!el) return;
  // A tall window of the same width: the pane stops scrolling, so the element
  // is drawn whole, in the layout of that width.
  const size = page.viewportSize()!;
  await page.setViewportSize({ width: size.width, height: 3200 });
  await el.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await el.screenshot({ path: `${SHOT_DIR}/${name}-whole.png` });
  await page.setViewportSize(size);
};

const card = (page: Page, code: string) => page.locator(`[data-testid="settlement-card"][data-cycle="${code}"]`);
const amountOf = async (el: ReturnType<Page['locator']>) => Number(await el.getAttribute('data-amount'));

/** The whole page fits the screen: nothing scrolls sideways. */
async function noSidewaysScroll(page: Page) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(over, 'page scrolls sideways').toBeLessThanOrEqual(1);
}

/**
 * Abdallah (60,000) and Shady (40,000) fund a cycle that sells 10 parts
 * landed at 100 for 300 each: 2,000 profit, 1,200 to A. Rent of 3,000 is
 * recorded first, so A's share of it — and whatever else earlier specs left
 * waiting — is his to pay from this payout.
 */
async function aWorld(request: any, label: string) {
  const { headers } = await apiCtx(request);
  const user = await usersByEmail(request, headers);
  const a = user('abdallah@motoparts.com');
  const b = user('shady@motoparts.com');
  await recordCost(request, headers, { amount: 3000, note: `${label} rent ${Date.now()}` });
  const w = await soldOutCycle(request, label, [[a.id, 'CORE_PARTNER', 60000], [b.id, 'CORE_PARTNER', 40000]]);
  return { ...w, a, b };
}

/** Through the menu: the sidebar on a desktop, the menu button on a phone (as spec 99-leftover-transfer). */
/** Partners, or its Settlements tab (a tab since 2026-10-18), by clicking. */
async function go(page: Page, path: 'settlements' | 'partners', locale: Locale = 'en') {
  if ((page.viewportSize()?.width ?? 1440) < 768) {
    await hideDevBadge(page);
    await page.locator('button:has(svg.icon-menu)').filter({ visible: true }).first().click();
    await page.locator(`a[href="/${locale}/partners"]`).filter({ visible: true }).first().click();
    await expect(page).toHaveURL(new RegExp(`/${locale}/partners$`), { timeout: 15000 });
    if (path === 'settlements') {
      await page.getByRole('main').getByRole('tab', { name: messages(locale).nav.settlements, exact: true }).click();
    }
  } else if (path === 'settlements') {
    await openView(page, 'settlements', locale);
  } else {
    await openNav(page, messages(locale).nav.partners);
  }
  await expect(page).toHaveURL(new RegExp(`/${locale}/partners${path === 'settlements' ? '\\?view=settlements' : ''}$`), { timeout: 15000 });
}
const openSettlements = (page: Page, locale: Locale = 'en') => go(page, 'settlements', locale);

test.describe('A payout takes his share of the running costs and says so (L7, §8)', () => {
  test('TC-RC-01: before paying it shows what paying today takes; paid, the line names its period and he is handed his payout less it; the Partners page agrees; reversing puts it back', async ({ page, request }) => {
    const m = messages('en');
    const w = await aWorld(request, 'RC01');
    const owedA = waitingFor(await runningCosts(request, w.headers), w.a.id);
    expect(owedA).toBeGreaterThan(0);
    const id = await approved(w.mk, w.cycle.id);
    const pidA = (await settlement(request, w.headers, id)).lines.find((l: any) => l.participant.partnerUserId === w.a.id).participantId;

    await login(page);
    await openSettlements(page);
    const c = card(page, w.cycle.code);
    const linesA = c.getByTestId(`breakdown-${pidA}`);
    await expect(linesA).toContainText(m.settlementsPage.runningCostsProjected);
    const running = linesA.locator('[data-line]').filter({ hasText: m.settlementsPage.runningCostsLine.slice(0, 12) });
    expect(cents(await amountOf(running))).toBe(-cents(owedA));
    expect(cents(await amountOf(linesA.locator('[data-total]')))).toBe(cents(61200 - owedA));
    // No lump "Expenses" anywhere on the card.
    await expect(c.getByText(m.settlementsPage.expenses, { exact: true })).toHaveCount(0);

    await c.getByRole('button', { name: m.settlementsPage.markPaid }).click();
    await expect(page.getByText(m.settlementsPage.paid)).toBeVisible();
    await expect(linesA).not.toContainText(m.settlementsPage.runningCostsProjected);
    await expect(linesA).toContainText(today());
    expect(cents(await amountOf(linesA.locator('[data-total]')))).toBe(cents(61200 - owedA));
    const payouts = (await settlementRows(request, w.headers, id)).filter((r) => r.type === 'SETTLEMENT_PAYOUT');
    expect(payouts.map((r) => cents(r.amount))).toContain(cents(61200 - owedA));

    // The Partners page: nothing of A's waits, and his payout opens to the same lines.
    await openNav(page, m.nav.partners);
    // Wait for the partner cards: while the page is its skeleton the
    // running-costs section is drawn inside it and replaced when they land,
    // taking an open period picker with it.
    await expect(page.locator('[data-testid="partner-card"]').first()).toBeVisible({ timeout: 30_000 });
    const section = page.getByTestId('running-costs');
    await section.getByRole('combobox').click();
    await page.getByRole('option', { name: m.partners.periodAll }).click();
    const rowA = section.getByTestId('running-costs-partners').getByRole('row').filter({ hasText: 'Abdallah' });
    await expect(rowA.locator('td').nth(3)).toHaveText(/^0\.00/);
    const partnerA = page.locator('[data-testid="partner-card"][data-email="abdallah@motoparts.com"]');
    const payout = partnerA.getByTestId('payout-history').getByRole('button').filter({ hasText: w.cycle.code });
    // The refetch after paying is /users/participation, slow late in a full run (above).
    await expect(payout).toBeVisible({ timeout: 30_000 });
    await payout.click();
    await expect(partnerA.getByTestId(`breakdown-${pidA}`)).toContainText(today());

    // Reverse it from the settlement card: his share waits again.
    await openSettlements(page);
    await card(page, w.cycle.code).getByRole('button', { name: m.settlementsPage.reverse }).click();
    await page.locator('#reverse-reason').fill('paid the wrong figures');
    await page.getByRole('button', { name: m.settlementsPage.reverse }).last().click();
    await expect(page.getByText(m.settlementsPage.updated)).toBeVisible();
    expect(cents(waitingFor(await runningCosts(request, w.headers), w.a.id))).toBe(cents(owedA));
  });
});

test.describe('Screens, line by line, in both languages (L7)', () => {
  for (const locale of ['en', 'ar'] as Locale[]) {
    for (const width of [1440, 390]) {
      test(`TC-RC-02 ${locale} ${width}: draft, approved and paid each read line by line; the Partners section and a payout fit the screen`, async ({ page, request }) => {
        const m = messages(locale);
        const tag = `${locale}-${width}`;
        await page.setViewportSize({ width, height: width < 768 ? 844 : 900 });
        const w = await aWorld(request, `RC02 ${tag}`);
        const draft = await w.mk(`settlements/calculate/${w.cycle.id}`, {});

        await login(page, locale);
        await openSettlements(page, locale);
        const c = card(page, w.cycle.code);
        const section = c.getByTestId('payout-breakdown');
        await expect(section).toContainText(m.settlementsPage.howWorkedOut);
        await expect(section).toContainText(m.settlementsPage.cycleProfit);
        await expect(section).toContainText(m.settlementsPage.runningCostsProjected);
        await expect(section).toContainText(m.settlementsPage.wouldBePaid);
        await noSidewaysScroll(page);
        await c.scrollIntoViewIfNeeded();
        await shot(page, `settlement-draft-${tag}`, c);

        await w.mk(`settlements/${draft.id}/approve`, {});
        await page.reload();
        await expect(card(page, w.cycle.code).getByTestId('payout-breakdown')).toContainText(m.settlementsPage.runningCostsProjected);
        await noSidewaysScroll(page);
        await shot(page, `settlement-approved-${tag}`, card(page, w.cycle.code));

        await card(page, w.cycle.code).getByRole('button', { name: m.settlementsPage.markPaid }).click();
        await expect(page.getByText(m.settlementsPage.paid)).toBeVisible();
        const paid = card(page, w.cycle.code).getByTestId('payout-breakdown');
        await expect(paid).toContainText(m.settlementsPage.paidToHim);
        await expect(paid).not.toContainText(m.settlementsPage.runningCostsProjected);
        await noSidewaysScroll(page);
        await shot(page, `settlement-paid-${tag}`, card(page, w.cycle.code));

        await go(page, 'partners', locale);
        // The partner cards have landed: until then the page is its skeleton,
        // and the running-costs section drawn inside it is replaced when they do.
        // 30s: /users/participation projects every open cycle in turn, and late in a
        // full run there are hundreds (BUILD_LOG "Known e2e debt", 2026-10-21).
        await expect(page.locator('[data-testid="partner-card"]').first()).toBeVisible({ timeout: 30_000 });
        const rc = page.getByTestId('running-costs');
        await expect(rc).toContainText(m.partners.runningCostsTitle);
        await expect(rc.getByTestId('running-costs-residual')).toBeVisible();
        await noSidewaysScroll(page);
        await rc.scrollIntoViewIfNeeded();
        await shot(page, `partners-running-costs-${tag}`, rc);

        const partnerA = page.locator('[data-testid="partner-card"][data-email="abdallah@motoparts.com"]');
        await partnerA.getByTestId('payout-history').getByRole('button').filter({ hasText: w.cycle.code }).click();
        await expect(partnerA.getByTestId('payout-breakdown')).toContainText(m.settlementsPage.capitalBack);
        await noSidewaysScroll(page);
        await partnerA.scrollIntoViewIfNeeded();
        await shot(page, `partners-payout-history-${tag}`, partnerA);
        if (locale === 'ar') {
          await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
          await expect(partnerA.getByTestId('payout-breakdown')).not.toContainText('Capital back');
        }
      });
    }
  }
});

test.describe('Nothing else changed for the people who are not charged', () => {
  test('TC-RC-03: a cycle with only an investor and one partner — the investor’s lines carry no running costs, in the browser too', async ({ page, request }) => {
    const m = messages('en');
    const { headers } = await apiCtx(request);
    const user = await usersByEmail(request, headers);
    const a = user('abdallah@motoparts.com');
    const investor = user('investor@motoparts.com');
    await recordCost(request, headers, { amount: 1500, category: 'utilities' });
    const w = await soldOutCycle(request, 'RC03', [[a.id, 'CORE_PARTNER', 50000], [investor.id, 'TEMP_INVESTOR', 50000, 10]]);
    const id = await approved(w.mk, w.cycle.id);
    const pidI = (await settlement(request, headers, id)).lines.find((l: any) => l.participant.participantType === 'TEMP_INVESTOR').participantId;
    await login(page);
    await openSettlements(page);
    const linesI = card(page, w.cycle.code).getByTestId(`breakdown-${pidI}`);
    await expect(linesI).toContainText(m.settlementsPage.investorFeeTaken);
    await expect(linesI).not.toContainText(m.settlementsPage.runningCostsLine);
  });
});
