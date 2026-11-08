import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import ar from '@/i18n/locales/ar.json';
import en from '@/i18n/locales/en.json';
import { formatDate } from '@/lib/dates';
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
  // Dates in a label are isolated (FSI..PDI) with non-breaking spaces so they stay whole; undo both to compare.
  [...root.querySelectorAll<HTMLElement>('[data-line] [data-label]')].map(
    (l) => l.textContent?.replace(/[⁨⁩]/g, '').replace(/ /g, ' ') ?? null,
  );
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
      // −150 is pounds saved on the dirham: said as a gain (owner 2026-11-06).
      en.exchangeResult.gain,
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

  // Owner 2026-11-06: "Exchange-rate loss on the lender repayments −3,183.74 —
  // this needs to show that it's a loss". The API's cost line is +3,183.74 for
  // a loss (it comes off the profit); −150 above is a gain.
  it('an exchange-rate loss reads as a loss: its label, hint, red, a minus — and still adds up', () => {
    const lossy: PayoutBreakdown = {
      ...BREAKDOWN,
      costs: [{ kind: 'exchange', category: null, amountEgp: '3183.74' }],
      expensesEgp: '3183.74',
      cycleProfitEgp: '36816.26',
    };
    renderIn('en', lossy);
    const cycle = screen.getByTestId('breakdown-cycle');
    const line = within(cycle).getByTestId('exchange-line');
    expect(within(line).getByTestId('exchange-line-label').textContent).toBe('Exchange-rate loss');
    expect(within(line).getByTestId('exchange-line-label').className).toContain('text-destructive');
    expect(within(line).getByTestId('exchange-line-hint').textContent).toBe(en.exchangeResult.lossHint);
    const amount = within(line).getByTestId('exchange-line-amount');
    expect(amount.textContent).toBe('−3,183.74 EGP');
    expect(amount.className).toContain('text-destructive');
    expect(cents(amounts(cycle).reduce((s, a) => s + a, 0))).toBe(cents(total(cycle)));
  });

  it('a gain reads as a gain: green, with a plus', () => {
    renderIn('en');
    const line = within(screen.getByTestId('breakdown-cycle')).getByTestId('exchange-line');
    expect(within(line).getByTestId('exchange-line-label').textContent).toBe('Exchange-rate gain');
    expect(within(line).getByTestId('exchange-line-amount').textContent).toBe('+150.00 EGP');
    expect(within(line).getByTestId('exchange-line-amount').className).toContain('text-success');
    cleanup();
    renderIn('ar');
    const arLine = within(screen.getByTestId('breakdown-cycle')).getByTestId('exchange-line');
    expect(within(arLine).getByTestId('exchange-line-label').textContent).toBe(ar.exchangeResult.gain);
    expect(within(arLine).getByTestId('exchange-line-hint').textContent).toBe(ar.exchangeResult.gainHint);
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
        .replace('{from}', 'Jul 1, 2026')
        .replace('{to}', 'Sep 30, 2026'),
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

  // §8, 2026-11-08: running costs are a cost inside the cycle now; an open
  // settlement no longer promises a deduction from anyone's payout.
  it('before it is paid it says "to be paid", with no running-cost line taken off', () => {
    const open = { ...BREAKDOWN.participants[0], runningCostsEgp: '0.00', runningCostsFrom: null, runningCostsTo: null, runningCostsStatus: 'none' as const, paidEgp: '54189.00' };
    renderIn('en', { ...BREAKDOWN, participants: [open] }, 'APPROVED');
    const a = screen.getByTestId('breakdown-p-a');
    expect(labels(a).some((l) => l?.startsWith(en.settlementsPage.runningCostsLine))).toBe(false);
    expect(a.textContent).not.toContain('If paid today');
    expect(a.querySelector('[data-total] [data-label]')!.textContent).toBe(en.settlementsPage.wouldBePaid);
    expect(cents(amounts(a).reduce((s, x) => s + x, 0))).toBe(cents(total(a)));
  });

  it('a stray "projected" figure from an older API is not shown as a deduction', () => {
    renderIn('en', {
      ...BREAKDOWN,
      participants: [{ ...BREAKDOWN.participants[0], runningCostsStatus: 'projected', runningCostsFrom: null, runningCostsTo: null }],
    }, 'DRAFT');
    const a = screen.getByTestId('breakdown-p-a');
    expect(labels(a).some((l) => l?.startsWith(en.settlementsPage.runningCostsLine))).toBe(false);
  });

  it('an old settlement paid the old way keeps its running-cost line; reversed, it says it was put back', () => {
    renderIn('en', {
      ...BREAKDOWN,
      participants: [{ ...BREAKDOWN.participants[0], runningCostsStatus: 'released' }],
    }, 'REVERSED');
    const a = screen.getByTestId('breakdown-p-a');
    expect(labels(a).some((l) => l?.startsWith(en.settlementsPage.runningCostsLine))).toBe(true);
    expect(within(a).getByText(en.settlementsPage.runningCostsReleased)).toBeTruthy();
  });
});

describe('running costs shared to the cycle (§8, 2026-11-08)', () => {
  // 1,200 rent and 300 fuel shared to this cycle while it sold: 1,500 more
  // cost, 35,150 profit; the cost lines still come to the expenses figure.
  const SHARED: PayoutBreakdown = {
    ...BREAKDOWN,
    costs: [
      ...BREAKDOWN.costs!,
      { kind: 'shared', category: 'rent', amountEgp: '1200.00' },
      { kind: 'shared', category: 'fuel', amountEgp: '300.00' },
    ],
    expensesEgp: '4850.00',
    cycleProfitEgp: '35150.00',
  };
  const costLines = (cycle: HTMLElement) => amounts(cycle).slice(2);

  it('each is a cost line named for its category, saying it is a running cost shared to this cycle', () => {
    renderIn('en', SHARED);
    const cycle = screen.getByTestId('breakdown-cycle');
    expect(labels(cycle).slice(-2)).toEqual([
      'Rent — running cost shared to this cycle',
      en.settlementsPage.costShared.replace('{category}', en.codes.ledgerCategory.fuel),
    ]);
    // A cost: it comes off the profit, like a charge.
    expect(amounts(cycle).slice(-2)).toEqual([-1200, -300]);
  });

  it('the lines still add up to the profit, and the costs to the expenses figure', () => {
    renderIn('en', SHARED);
    const cycle = screen.getByTestId('breakdown-cycle');
    expect(cents(amounts(cycle).reduce((s, a) => s + a, 0))).toBe(cents(total(cycle)));
    expect(total(cycle)).toBe(35150);
    expect(cents(-costLines(cycle).reduce((s, a) => s + a, 0))).toBe(cents(Number(SHARED.expensesEgp)));
  });

  it('in Arabic: the category and the explanation are Arabic', () => {
    renderIn('ar', SHARED);
    const cycle = screen.getByTestId('breakdown-cycle');
    const [rent] = labels(cycle).slice(-2);
    expect(rent).toBe(ar.settlementsPage.costShared.replace('{category}', ar.codes.ledgerCategory.rent));
    expect(rent).toContain('مصروف عام');
    expect(cycle.textContent).not.toMatch(/running cost|Rent|Fuel/);
  });

  it('every participant bears it through the profit: no payout carries a running-cost line for it', () => {
    renderIn('en', {
      ...SHARED,
      participants: SHARED.participants.map((p) => ({ ...p, runningCostsEgp: '0.00', runningCostsFrom: null, runningCostsTo: null, runningCostsStatus: 'none' as const })),
    }, 'APPROVED');
    for (const id of ['p-a', 'p-i']) {
      expect(labels(screen.getByTestId(`breakdown-${id}`)).some((l) => l?.startsWith(en.settlementsPage.runningCostsLine))).toBe(false);
    }
  });
});

describe('profit taken before settlement (§8, 2026-11-08)', () => {
  it('a "Profit taken" line comes off his payout, and the lines still add up to what he is paid', () => {
    renderIn('en', {
      ...BREAKDOWN,
      participants: [{ ...BREAKDOWN.participants[0], profitDrawnEgp: '-20000.00', owedEgp: '0.00', paidEgp: '24189.00' }],
    });
    const a = screen.getByTestId('breakdown-p-a');
    expect(labels(a)).toContain(en.settlementsPage.profitTakenLine);
    expect(labels(a)).not.toContain(en.settlementsPage.owedLine);
    expect(cents(amounts(a).reduce((s, x) => s + x, 0))).toBe(cents(total(a)));
    expect(total(a)).toBe(24189);
  });

  it('took more than the payout: what he owes is its own line, the total is 0 and still adds up', () => {
    renderIn('ar', {
      ...BREAKDOWN,
      participants: [{ ...BREAKDOWN.participants[0], profitDrawnEgp: '-50000.00', owedEgp: '5811.00', paidEgp: '0.00' }],
    }, 'APPROVED');
    const a = screen.getByTestId('breakdown-p-a');
    expect(labels(a)).toContain(ar.settlementsPage.profitTakenLine);
    expect(labels(a)).toContain(ar.settlementsPage.owedLine);
    expect(cents(amounts(a).reduce((s, x) => s + x, 0))).toBe(cents(total(a)));
    expect(total(a)).toBe(0);
  });

  it('none taken, or a breakdown from before draws existed: no such lines', () => {
    renderIn('en');
    const a = screen.getByTestId('breakdown-p-a');
    expect(labels(a)).not.toContain(en.settlementsPage.profitTakenLine);
    expect(labels(a)).not.toContain(en.settlementsPage.owedLine);
  });
});

describe('the running-costs line', () => {
  it('costs all spent on one day name that day once, not "d – d"', () => {
    renderIn('en', {
      ...BREAKDOWN,
      participants: [{ ...BREAKDOWN.participants[0], runningCostsFrom: '2026-10-12', runningCostsTo: '2026-10-12' }],
    });
    expect(labels(screen.getByTestId('breakdown-p-a'))[3]).toBe(
      en.settlementsPage.runningCostsDay.replace('{day}', 'Oct 12, 2026'),
    );
  });
});

describe('both languages, logical sides only', () => {
  // UI audit M7 (2026-11-06): the range was ISO, unlike every other date in
  // the app, broke apart in Arabic and wrapped mid-date in English. Each date
  // is now the app's own format, isolated, with no space a line can break at.
  const runningLabel = () =>
    screen.getByTestId('breakdown-p-a').querySelectorAll('[data-line] [data-label]')[3].textContent!;
  const whole = (d: string) => `⁨${d.replace(/\s/g, ' ')}⁩`;

  it('Arabic: each date in the app\'s Arabic format, isolated whole, never ISO', () => {
    renderIn('ar');
    const label = runningLabel();
    const from = formatDate('2026-07-01', { locale: 'ar' });
    const to = formatDate('2026-09-30', { locale: 'ar' });
    expect(from).toMatch(/[؀-ۿ]/);
    expect(label).toBe(ar.settlementsPage.runningCostsPeriod.replace('{from}', whole(from)).replace('{to}', whole(to)));
    expect(label).not.toMatch(/2026-0\d-\d\d/);
  });

  it('English: no space inside a date a line could wrap at; the range may wrap between them', () => {
    renderIn('en');
    const label = runningLabel();
    expect(label).toContain('⁨Jul 1, 2026⁩');
    expect(label).toContain('⁨Sep 30, 2026⁩');
    for (const date of label.match(/⁨[^⁩]*⁩/g)!) expect(date).not.toMatch(/ /);
  });

  it('a one-day range is one whole date too', () => {
    renderIn('ar', {
      ...BREAKDOWN,
      participants: [{ ...BREAKDOWN.participants[0], runningCostsFrom: '2026-10-12', runningCostsTo: '2026-10-12' }],
    });
    expect(runningLabel()).toBe(
      ar.settlementsPage.runningCostsDay.replace('{day}', whole(formatDate('2026-10-12', { locale: 'ar' }))),
    );
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
