/* eslint-disable @typescript-eslint/no-explicit-any -- API responses are parsed JSON; each assertion names the field it checks */
/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: running costs are a cost of the cycles selling, and a
 *  payout explains itself
 * ═══════════════════════════════════════════════════════════════════════
 *  BUSINESS_LOGIC §8 (owner 2026-10-11; changed 2026-11-08). Rent, fuel,
 *  packaging — costs with no cycle — are shared equally to the cycles selling
 *  when each is recorded (or wait for the next to start selling), and sit
 *  inside that cycle's profit, so everyone in it bears them by share,
 *  investors too. No payout is charged for them any more. The settlement
 *  screen and the Partners page lay every payout out line by line.
 *
 *  Screens are reached through the menu (CLAUDE.md §2); cycles are built the
 *  way the business builds them (§4). The money invariants are in 34
 *  (TC-INV-59..64); the arithmetic in apps/api/src/common/running-costs.spec.ts
 *  and the service in apps/api/src/modules/settlements/running-costs.flow.spec.ts.
 *
 *  `L7_SHOTS=1` also writes the review screenshots to .ui-audit/l7/.
 */
import { test, expect, type Page } from '@playwright/test';
import { apiCtx } from './support/fixtures';
import {
  approved,
  cents,
  recordCost,
  settlement,
  settlementRows,
  soldOutCycle,
  usersByEmail,
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
 * landed at 100 for 300 each. Rent of 3,000 is recorded first, with nothing
 * of this cycle selling yet: it waits, and goes to the cycles selling when
 * this one starts selling — this one among them — as a cost in its profit.
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

/**
 * The cycle's own lines add up to its profit, and each participant's to what
 * he is paid: the promise the breakdown makes, read from `data-amount`.
 */
async function linesSumToTotal(dl: ReturnType<Page['locator']>) {
  const amounts = await dl.locator('[data-line]').evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-amount'))));
  const total = await amountOf(dl.locator('[data-total]'));
  expect(cents(amounts.reduce((s, a) => s + a, 0))).toBe(cents(total));
}

/** The shared line's label for a category, in the reader's language. */
const sharedLabel = (m: ReturnType<typeof messages>, category: string) =>
  m.settlementsPage.costShared.replace('{category}', (m.codes.ledgerCategory as Record<string, string>)[category]);

test.describe('A running cost is a cost of the cycles selling, borne by everyone (§8, 2026-11-08)', () => {
  test('TC-RC-01: rent recorded while the cycle sells is a line inside its profit; no payout line takes running costs, before or after paying; the Partners page lists the cycle and links to it', async ({ page, request }) => {
    const m = messages('en');
    const w = await aWorld(request, 'RC01');
    const id = await approved(w.mk, w.cycle.id);
    const pidA = (await settlement(request, w.headers, id)).lines.find((l: any) => l.participant.partnerUserId === w.a.id).participantId;

    await login(page);
    await openSettlements(page);
    const c = card(page, w.cycle.code);
    const cycleLines = c.getByTestId('breakdown-cycle');
    await expect(cycleLines).toContainText(sharedLabel(m, 'rent'));
    await linesSumToTotal(cycleLines);
    const linesA = c.getByTestId(`breakdown-${pidA}`);
    // Nothing is promised off his payout any more.
    await expect(linesA).not.toContainText(m.settlementsPage.runningCostsLine.slice(0, 12));
    await linesSumToTotal(linesA);
    // No lump "Expenses" anywhere on the card.
    await expect(c.getByText(m.settlementsPage.expenses, { exact: true })).toHaveCount(0);

    await c.getByRole('button', { name: m.settlementsPage.markPaid }).click();
    await expect(page.getByText(m.settlementsPage.paid)).toBeVisible();
    await expect(linesA).not.toContainText(m.settlementsPage.runningCostsLine.slice(0, 12));
    await expect(cycleLines).toContainText(sharedLabel(m, 'rent'));
    const total = await amountOf(linesA.locator('[data-total]'));
    const payouts = (await settlementRows(request, w.headers, id)).filter((r) => r.type === 'SETTLEMENT_PAYOUT');
    expect(payouts.map((r) => cents(r.amount))).toContain(cents(total));

    // The Partners page: the cycle is listed under "Shared to cycles", and its code opens it.
    await openNav(page, m.nav.partners);
    await expect(page.locator('[data-testid="partner-card"]').first()).toBeVisible({ timeout: 30_000 });
    const section = page.getByTestId('running-costs');
    await section.getByRole('combobox').click();
    await page.getByRole('option', { name: m.partners.periodAll }).click();
    const link = section.getByTestId('running-costs-cycles').getByRole('link', { name: w.cycle.code });
    await expect(link).toBeVisible();
    await link.click();
    await expect(page).toHaveURL(new RegExp(`/en/cycles/${w.cycle.id}/details`), { timeout: 15000 });
  });
});

test.describe('Screens, line by line, in both languages (§8, 2026-11-08)', () => {
  for (const locale of ['en', 'ar'] as Locale[]) {
    for (const width of [1440, 390]) {
      test(`TC-RC-02 ${locale} ${width}: draft, approved and paid each read line by line with the shared rent; the Partners section and a payout fit the screen`, async ({ page, request }) => {
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
        await expect(section).toContainText(sharedLabel(m, 'rent'));
        await expect(section).toContainText(m.settlementsPage.cycleProfit);
        await expect(section).toContainText(m.settlementsPage.wouldBePaid);
        await noSidewaysScroll(page);
        await c.scrollIntoViewIfNeeded();
        await shot(page, `settlement-draft-${tag}`, c);

        await w.mk(`settlements/${draft.id}/approve`, {});
        await page.reload();
        await expect(card(page, w.cycle.code).getByTestId('payout-breakdown')).toContainText(sharedLabel(m, 'rent'));
        await noSidewaysScroll(page);
        await shot(page, `settlement-approved-${tag}`, card(page, w.cycle.code));

        await card(page, w.cycle.code).getByRole('button', { name: m.settlementsPage.markPaid }).click();
        await expect(page.getByText(m.settlementsPage.paid)).toBeVisible();
        const paid = card(page, w.cycle.code).getByTestId('payout-breakdown');
        await expect(paid).toContainText(m.settlementsPage.paidToHim);
        await expect(paid).toContainText(sharedLabel(m, 'rent'));
        await noSidewaysScroll(page);
        await shot(page, `settlement-paid-${tag}`, card(page, w.cycle.code));

        await go(page, 'partners', locale);
        // 30s: /users/participation projects every open cycle in turn, and late in a
        // full run there are hundreds (build-log/history/2026-10.md "Known e2e debt").
        await expect(page.locator('[data-testid="partner-card"]').first()).toBeVisible({ timeout: 30_000 });
        const rc = page.getByTestId('running-costs');
        await expect(rc).toContainText(m.partners.runningCostsTitle);
        await expect(rc.getByTestId('running-costs-shared')).toBeVisible();
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
          await expect(rc).not.toContainText('Shared to cycles');
        }
      });
    }
  }
});

test.describe('Investors bear running costs too, through the cycle’s profit', () => {
  test('TC-RC-03: a cycle with an investor and one partner — the shared cost sits in the cycle’s lines, and nobody’s payout carries a running-cost line', async ({ page, request }) => {
    const m = messages('en');
    const { headers } = await apiCtx(request);
    const user = await usersByEmail(request, headers);
    const a = user('abdallah@motoparts.com');
    const investor = user('investor@motoparts.com');
    const w = await soldOutCycle(request, 'RC03', [[a.id, 'CORE_PARTNER', 50000], [investor.id, 'TEMP_INVESTOR', 50000, 10]]);
    // Recorded while the cycle sells: shared to it (and any other cycle selling).
    await recordCost(request, headers, { amount: 1500, category: 'utilities' });
    const id = await approved(w.mk, w.cycle.id);
    const pidI = (await settlement(request, headers, id)).lines.find((l: any) => l.participant.participantType === 'TEMP_INVESTOR').participantId;
    await login(page);
    await openSettlements(page);
    const c = card(page, w.cycle.code);
    await expect(c.getByTestId('breakdown-cycle')).toContainText(sharedLabel(m, 'utilities'));
    const linesI = c.getByTestId(`breakdown-${pidI}`);
    await expect(linesI).toContainText(m.settlementsPage.investorFeeTaken);
    await expect(linesI).not.toContainText(m.settlementsPage.runningCostsLine);
  });
});
