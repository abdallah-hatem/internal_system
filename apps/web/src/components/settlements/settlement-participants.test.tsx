import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import ar from '@/i18n/locales/ar.json';
import en from '@/i18n/locales/en.json';
import { participantRows, SettlementParticipants, type SettlementLine } from './settlement-participants';

afterEach(cleanup);

const line = (
  id: string,
  participantId: string,
  component: string,
  amount: number,
  who: Partial<SettlementLine['participant']> = {},
): SettlementLine => ({
  id,
  component,
  amount,
  participant: { id: participantId, participantType: 'CORE_PARTNER', ...who },
});

const partner = { partner: { partner: { displayName: 'Abdallah Hatem Kortam Abdelrahman' } } };
const investor = {
  participantType: 'TEMP_INVESTOR',
  investor: { email: 'investor@example.com' },
};

const LINES: SettlementLine[] = [
  line('1', 'p1', 'CAPITAL_RETURN', 100000, partner),
  line('2', 'p1', 'PROFIT_SHARE', 45000, partner),
  line('3', 'p1', 'INVESTOR_FEE_RECEIVED', 2500, partner),
  line('4', 'p2', 'CAPITAL_RETURN', 50000, investor),
  line('5', 'p2', 'PROFIT_SHARE', 20000, investor),
  line('6', 'p2', 'INVESTOR_FEE', -2500, investor),
  line('7', 'p3', 'PROFIT_SHARE', 0, {}),
];

function renderIn(locale: 'en' | 'ar', lines = LINES) {
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : ar} timeZone="Africa/Cairo">
      <SettlementParticipants lines={lines} cycleCode="CYC-2026-0001" />
    </NextIntlClientProvider>,
  );
}

describe('participantRows', () => {
  it('a fee already taken from the profit share is not taken from the payout again', () => {
    const [p1, p2] = participantRows(LINES);
    expect(p1.payout).toBe(100000 + 45000 + 2500);
    expect(p2.payout).toBe(50000 + 20000);
    expect(p2.fee).toBe(-2500);
  });

  it('his share of the running costs comes off his payout (L7), and only his', () => {
    const [p1, p2] = participantRows([
      ...LINES,
      line('8', 'p1', 'RUNNING_COSTS', -10000, partner),
    ]);
    expect(p1.runningCosts).toBe(-10000);
    expect(p1.payout).toBe(100000 + 45000 + 2500 - 10000);
    expect(p2.runningCosts).toBe(0);
    expect(p2.payout).toBe(50000 + 20000);
  });

  it('before it is paid, what paying today would take comes off the payout shown — the table agrees with the breakdown', () => {
    const [p1, p2] = participantRows(LINES, { p1: -10000 });
    expect(p1.runningCosts).toBe(-10000);
    expect(p1.payout).toBe(100000 + 45000 + 2500 - 10000);
    expect(p2.payout).toBe(50000 + 20000);
    // Once paid, the settlement's own line wins over any projection.
    const [paid] = participantRows([...LINES, line('9', 'p1', 'RUNNING_COSTS', -4000, partner)], { p1: -10000 });
    expect(paid.runningCosts).toBe(-4000);
  });

  it('a participant with no name or email has none, and no lines means no rows', () => {
    expect(participantRows(LINES)[2].name).toBeNull();
    expect(participantRows([])).toEqual([]);
  });
});

describe('SettlementParticipants on a phone (UI audit 2026-10-10 #1)', () => {
  it('gives each participant a card with every amount labelled, Fee and running costs included', () => {
    renderIn('ar');
    const cards = within(screen.getByTestId('settlement-participants-cards')).getAllByRole('listitem');
    expect(cards).toHaveLength(3);
    const labels = [...cards[1].querySelectorAll('dt')].map((d) => d.textContent);
    expect(labels).toEqual([
      ar.settlementsPage.capital,
      ar.settlementsPage.netProfit,
      ar.settlementsPage.fee,
      ar.settlementsPage.runningCosts,
      ar.settlementsPage.payout,
    ]);
    // Amount and currency stay on one line.
    for (const dd of cards[1].querySelectorAll('dd')) {
      expect(dd.className).toContain('whitespace-nowrap');
    }
  });

  it('says "unknown" and the fee tooltip in the reader\'s language', () => {
    renderIn('ar');
    const cards = within(screen.getByTestId('settlement-participants-cards')).getAllByRole('listitem');
    expect(cards[2].textContent).toContain(ar.settlementsPage.unknownParticipant);
    expect(cards[1].querySelector('[title]')!.getAttribute('title')).toBe(ar.settlementsPage.feeAlreadyDeducted);
    expect(cards[2].textContent).not.toMatch(/Unknown|Already deducted/);
  });

  it('a zero fee reads as a dash, not 0.00 EGP', () => {
    renderIn('en');
    const cards = within(screen.getByTestId('settlement-participants-cards')).getAllByRole('listitem');
    expect(cards[2].querySelectorAll('dd')[2].textContent).toBe('—');
  });

  it('keeps the table, hidden below md, for wider screens', () => {
    const { container } = renderIn('en');
    const table = container.querySelector('table')!;
    // The shared table's frame (components/ui/data-table.tsx) around its scroller.
    const frame = table.parentElement!.parentElement!;
    expect(frame.className).toContain('hidden');
    expect(frame.className).toContain('md:block');
    expect(table.querySelectorAll('tbody tr')).toHaveLength(3);
  });
});
