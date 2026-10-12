import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/locales/en.json';
import { PayoutHistory, type PartnerPayout } from './payout-history';

/**
 * L7 — each partner's payout history on the Partners page explains itself,
 * with the very breakdown the settlement screen shows (§8).
 */

afterEach(cleanup);

const PAYOUT: PartnerPayout = {
  settlementId: 's-1',
  cycleId: 'c-1',
  cycleCode: 'CYC-2026-0007',
  paidAt: '2026-10-05T10:00:00.000Z',
  breakdown: {
    revenueEgp: '80000.00',
    cogsEgp: '50000.00',
    costs: [{ kind: 'charge', category: 'extra_freight', amountEgp: '2000.00' }],
    expensesEgp: '2000.00',
    cycleProfitEgp: '28000.00',
    leftoversMovedEgp: '0.00',
    participants: [
      {
        participantId: 'p-a',
        type: 'CORE_PARTNER',
        sharePct: '40.00',
        profitShareEgp: '11200.00',
        investorFeeEgp: '0.00',
        feeReceivedEgp: '280.00',
        capitalBackEgp: '20000.00',
        runningCostsEgp: '-11000.00',
        runningCostsFrom: '2026-09-01',
        runningCostsTo: '2026-09-20',
        runningCostsStatus: 'charged',
        paidEgp: '20480.00',
      },
    ],
  },
};

function renderIt(payouts: PartnerPayout[]) {
  return render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="Africa/Cairo">
      <PayoutHistory payouts={payouts} name="Abdallah" />
    </NextIntlClientProvider>,
  );
}

describe('a partner’s payout history', () => {
  it('each payout: its cycle, the day, what he was paid — and the lines that make it up', () => {
    renderIt([PAYOUT]);
    const item = within(screen.getByTestId('payout-history')).getByRole('listitem');
    const toggle = within(item).getByRole('button');
    expect(toggle.textContent).toContain('CYC-2026-0007');
    expect(toggle.textContent).toContain('20,480.00');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const lines = within(item).getByTestId('breakdown-p-a');
    expect(lines.textContent).toContain(
      en.settlementsPage.runningCostsPeriod.replace('{from}', '2026-09-01').replace('{to}', '2026-09-20'),
    );
    expect(within(item).getByText('Abdallah')).toBeTruthy();
  });

  it('nothing paid yet says so', () => {
    renderIt([]);
    expect(screen.getByText(en.partners.noPayouts)).toBeTruthy();
  });
});
