import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import ar from '@/i18n/locales/ar.json';
import en from '@/i18n/locales/en.json';
import { PayoutBreakdownView, type PayoutBreakdown } from './payout-breakdown';

/**
 * L7 — a payout explains itself (BUSINESS_LOGIC §8, owner 2026-10-11).
 *
 * The figures come from the API, from the settlement's own projection; this
 * only lays them out. What is pinned: no lump "Expenses" line, every line
 * the owner listed, and lines that visibly add up to the total they sit over.
 */

afterEach(cleanup);

// 90,000 revenue, 50,000 cost of goods, 3,000 extra freight, 1,000 lost on the
// way, 150 gained on the dirham, 500 back from the supplier: 36,650 profit.
const BREAKDOWN: PayoutBreakdown = {
  revenueEgp: '90000.00',
  cogsEgp: '50000.00',
  costs: [
    { kind: 'charge', category: 'extra_freight', amountEgp: '3000.00' },
    { kind: 'loss', category: null, amountEgp: '1000.00' },
    { kind: 'exchange', category: null, amountEgp: '-150.00' },
    { kind: 'recovery', category: 'supplier_refund', amountEgp: '-500.00' },
  ],
  expensesEgp: '3350.00',
  cycleProfitEgp: '36650.00',
  leftoversMovedEgp: '2200.00',
  participants: [
    {
      participantId: 'p-a',
      type: 'CORE_PARTNER',
      sharePct: '60.00',
      profitShareEgp: '21990.00',
      investorFeeEgp: '0.00',
      feeReceivedEgp: '2199.00',
      capitalBackEgp: '30000.00',
      runningCostsEgp: '-10000.00',
      runningCostsFrom: '2026-07-01',
      runningCostsTo: '2026-09-30',
      runningCostsStatus: 'charged',
      paidEgp: '44189.00',
    },
    {
      participantId: 'p-i',
      type: 'TEMP_INVESTOR',
      sharePct: '40.00',
      profitShareEgp: '14660.00',
      investorFeeEgp: '-2199.00',
      feeReceivedEgp: '0.00',
      capitalBackEgp: '20000.00',
      runningCostsEgp: '0.00',
      runningCostsFrom: null,
      runningCostsTo: null,
      runningCostsStatus: 'none',
      paidEgp: '32461.00',
    },
  ],
};

function renderIn(locale: 'en' | 'ar', b: PayoutBreakdown = BREAKDOWN, status = 'PAID') {
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : ar} timeZone="Africa/Cairo">
      <PayoutBreakdownView
        breakdown={b}
        status={status}
        names={{ 'p-a': 'Abdallah', 'p-i': 'Investor' }}
      />
    </NextIntlClientProvider>,
  );
}

const amounts = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLElement>('[data-line]')].map((l) => Number(l.dataset.amount));
const total = (root: HTMLElement) =>
  Number(root.querySelector<HTMLElement>('[data-total]')!.dataset.amount);
const labels = (root: HTMLElement) =>
  // Dates in a label are wrapped in LRI…PDI so Arabic keeps them whole; strip them to compare.
  [...root.querySelectorAll<HTMLElement>('[data-line] [data-label]')].map((l) => l.textContent?.replace(/[\u2066\u2069]/g, '') ?? null);
const cents = (n: number) => Math.round(n * 100);

describe('the cycle’s lines', () => {
  it('revenue, cost of goods, each cost by kind — and no lump "Expenses"', () => {
    renderIn('en');
    const cycle = screen.getByTestId('breakdown-cycle');
    expect(labels(cycle)).toEqual([
      en.settlementsPage.revenue,
      en.settlementsPage.cogsLine,
      en.codes.ledgerCategory.extra_freight,
      en.settlementsPage.costLoss,
      en.settlementsPage.costExchange,
      en.settlementsPage.costRecovery.replace('{category}', en.codes.ledgerCategory.supplier_refund),
    ]);
    expect(cycle.textContent).not.toContain(en.settlementsPage.expenses);
  });

  it('they add up to the cycle profit shown under them', () => {
    renderIn('en');
    const cycle = screen.getByTestId('breakdown-cycle');
    expect(cents(amounts(cycle).reduce((s, a) => s + a, 0))).toBe(cents(total(cycle)));
    expect(total(cycle)).toBe(36650);
  });

  it('leftovers moved are stated beside the figures, not inside them', () => {
    renderIn('en');
    const note = screen.getByTestId('breakdown-leftovers');
    expect(note.textContent).toContain(en.settlementsPage.leftoversMoved);
    expect(note.hasAttribute('data-line')).toBe(false);
  });

  it('a settlement from before costs were itemised says so, in one honest line', () => {
    renderIn('en', { ...BREAKDOWN, costs: null });
    const cycle = screen.getByTestId('breakdown-cycle');
    expect(labels(cycle)).toContain(en.settlementsPage.costsNotItemised);
    expect(cents(amounts(cycle).reduce((s, a) => s + a, 0))).toBe(cents(total(cycle)));
  });
});

describe('each participant’s lines', () => {
  it('a partner: share of profit, fee received, capital back, share of running costs (period) — summing to what he was paid', () => {
    renderIn('en');
    const a = screen.getByTestId('breakdown-p-a');
    expect(labels(a)).toEqual([
      en.settlementsPage.shareOfProfitPct.replace('{pct}', '60.00'),
      en.settlementsPage.investorFeeReceived,
      en.settlementsPage.capitalBack,
      en.settlementsPage.runningCostsPeriod
        .replace('{from}', '2026-07-01')
        .replace('{to}', '2026-09-30'),
    ]);
    expect(cents(amounts(a).reduce((s, x) => s + x, 0))).toBe(cents(total(a)));
    expect(total(a)).toBe(44189);
  });

  it('the investor: his fee taken off, never a running-cost line', () => {
    renderIn('en');
    const i = screen.getByTestId('breakdown-p-i');
    expect(labels(i)).toContain(en.settlementsPage.investorFeeTaken);
    expect(labels(i).some((l) => l?.startsWith(en.settlementsPage.runningCostsLine))).toBe(false);
    expect(cents(amounts(i).reduce((s, x) => s + x, 0))).toBe(cents(total(i)));
  });

  it('before it is paid it says "to be paid" and that running costs are what paying today would take', () => {
    renderIn('en', {
      ...BREAKDOWN,
      participants: [{ ...BREAKDOWN.participants[0], runningCostsStatus: 'projected' }],
    }, 'APPROVED');
    const a = screen.getByTestId('breakdown-p-a');
    expect(within(a).getByText(en.settlementsPage.runningCostsProjected)).toBeTruthy();
    expect(a.querySelector('[data-total] [data-label]')!.textContent).toBe(en.settlementsPage.wouldBePaid);
  });
});

describe('the running-costs line', () => {
  it('costs all spent on one day name that day once, not "d – d"', () => {
    renderIn('en', {
      ...BREAKDOWN,
      participants: [{ ...BREAKDOWN.participants[0], runningCostsFrom: '2026-10-12', runningCostsTo: '2026-10-12' }],
    });
    expect(labels(screen.getByTestId('breakdown-p-a'))[3]).toBe(
      en.settlementsPage.runningCostsDay.replace('{day}', '2026-10-12'),
    );
  });
});

describe('both languages, logical sides only', () => {
  it('Arabic: a date in a line is isolated left-to-right, so "(2026-07-01 – 2026-09-30)" is not split', () => {
    renderIn('ar');
    const label = screen.getByTestId('breakdown-p-a').querySelectorAll('[data-line] [data-label]')[3].textContent!;
    expect(label).toContain('\u20662026-07-01\u2069');
    expect(label).toContain('\u20662026-09-30\u2069');
  });

  it('Arabic: every line in Arabic, amounts kept left-to-right', () => {
    renderIn('ar');
    const a = screen.getByTestId('breakdown-p-a');
    expect(labels(a)[2]).toBe(ar.settlementsPage.capitalBack);
    expect(a.textContent).not.toMatch(/Capital back|Share of/);
    for (const m of a.querySelectorAll('[data-slot="money"]')) {
      expect(m.getAttribute('dir')).toBe('ltr');
    }
  });

  it('the source uses start/end, never left/right', () => {
    const file = './payout-breakdown.tsx';
    const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
    expect(source).not.toMatch(/\b(ml|mr|pl|pr|left|right)-\d|text-(left|right)\b/);
  });
});
