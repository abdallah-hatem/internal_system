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

  it('no RUNNING_COSTS line (every settlement since 2026-11-08): nothing comes off the payout for running costs', () => {
    // They are a cost inside the cycle's profit now (§8), already in PROFIT_SHARE.
    const [p1, p2] = participantRows(LINES);
    expect(p1.runningCosts).toBe(0);
    expect(p1.payout).toBe(100000 + 45000 + 2500);
    expect(p2.runningCosts).toBe(0);
  });

  it('profit he took before settlement comes off his payout (§8, 2026-11-08), and only his', () => {
    const [p1, p2] = participantRows([...LINES, line('8', 'p1', 'PROFIT_DRAWN', -40000, partner)]);
    expect(p1.profitDrawn).toBe(-40000);
    expect(p1.owed).toBe(0);
    expect(p1.payout).toBe(100000 + 45000 + 2500 - 40000);
    expect(p2.profitDrawn).toBe(0);
    expect(p2.payout).toBe(50000 + 20000);
  });

  it('took more than his payout came to: the payout is 0, never below, and the rest is owed', () => {
    // 10,000 share, 25,000 taken: 15,000 owed, paid nothing.
    const [p] = participantRows([
      line('1', 'p1', 'PROFIT_SHARE', 10000, partner),
      line('2', 'p1', 'PROFIT_DRAWN', -25000, partner),
    ]);
    expect(p.payout).toBe(0);
    expect(p.owed).toBe(15000);
  });

  it('owed is never more than he took: a loss beyond his draws stays a negative payout', () => {
    // A 30,000 loss share and 5,000 taken: he owes the 5,000; the rest is the loss it always was.
    const [p] = participantRows([
      line('1', 'p1', 'PROFIT_SHARE', -30000, partner),
      line('2', 'p1', 'PROFIT_DRAWN', -5000, partner),
    ]);
    expect(p.owed).toBe(5000);
    expect(p.payout).toBe(-30000);
  });

  it('to the piastre: a payout his draws exactly cancel reads 0, not -0.00', () => {
    const [p] = participantRows([
      line('1', 'p1', 'PROFIT_SHARE', 0.1, partner),
      line('2', 'p1', 'CAPITAL_RETURN', 0.2, partner),
      line('3', 'p1', 'PROFIT_DRAWN', -0.3, partner),
    ]);
    expect(Object.is(p.payout, 0)).toBe(true);
    expect(p.owed).toBe(0);
  });

  it('capital the investor took back early comes off his payout, the split untouched (§8, 2026-11-08)', () => {
    const [p1, p2] = participantRows([...LINES, line('9', 'p2', 'CAPITAL_TAKEN_EARLY', -14000, investor)]);
    expect(p2.capitalTakenEarly).toBe(-14000);
    expect(p2.share).toBe(20000);
    expect(p2.payout).toBe(50000 + 20000 - 14000);
    expect(p1.capitalTakenEarly).toBe(0);
  });

  it('a loss below the capital he took back early: what that capital accounts for is owed, the rest is the loss', () => {
    // 20,000 capital, −25,000 loss share, 8,000 taken back: short 13,000, 8,000 of it owed.
    const [p] = participantRows([
      line('1', 'p2', 'CAPITAL_RETURN', 20000, investor),
      line('2', 'p2', 'PROFIT_SHARE', -25000, investor),
      line('3', 'p2', 'CAPITAL_TAKEN_EARLY', -8000, investor),
    ]);
    expect(p.owed).toBe(8000);
    expect(p.payout).toBe(-5000);
  });

  it('capital taken back: its own column and card line only when someone took some', () => {
    const { container } = renderIn('en', [...LINES, line('9', 'p2', 'CAPITAL_TAKEN_EARLY', -14000, investor)]);
    expect([...container.querySelectorAll('th')].map((th) => th.textContent)).toContain(en.settlementsPage.capitalTakenBack);
    cleanup();
    const plain = renderIn('en');
    expect(plain.container.textContent).not.toContain(en.settlementsPage.capitalTakenBack);
  });

  it('a participant with no name or email has none, and no lines means no rows', () => {
    expect(participantRows(LINES)[2].name).toBeNull();
    expect(participantRows([])).toEqual([]);
  });
});

describe('SettlementParticipants on a phone (UI audit 2026-10-10 #1)', () => {
  it('gives each participant a card with every amount labelled, Fee included — no running-costs line on a settlement without one', () => {
    renderIn('ar');
    const cards = within(screen.getByTestId('settlement-participants-cards')).getAllByRole('listitem');
    expect(cards).toHaveLength(3);
    const labels = [...cards[1].querySelectorAll('dt')].map((d) => d.textContent);
    expect(labels).toEqual([
      ar.settlementsPage.capital,
      ar.settlementsPage.netProfit,
      ar.settlementsPage.fee,
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

  it('a settlement paid before 2026-11-08 keeps its running-costs column and card line, a dash for whoever had none', () => {
    const { container } = renderIn('ar', [...LINES, line('8', 'p1', 'RUNNING_COSTS', -10000, partner)]);
    expect([...container.querySelectorAll('th')].map((th) => th.textContent)).toContain(ar.settlementsPage.runningCosts);
    const cards = within(screen.getByTestId('settlement-participants-cards')).getAllByRole('listitem');
    const labels = [...cards[0].querySelectorAll('dt')].map((d) => d.textContent);
    expect(labels).toContain(ar.settlementsPage.runningCosts);
    expect(cards[0].querySelectorAll('dd')[3].textContent).toContain('10,000.00');
    expect(cards[1].querySelectorAll('dd')[3].textContent).toBe('—');
  });

  it('no running costs taken: no running-costs column', () => {
    const { container } = renderIn('en');
    expect([...container.querySelectorAll('th')].map((th) => th.textContent)).not.toContain(en.settlementsPage.runningCosts);
  });

  it('no profit taken: no "Profit taken" column or label, so existing settlements read as before', () => {
    const { container } = renderIn('en');
    expect([...container.querySelectorAll('th')].map((th) => th.textContent)).not.toContain(en.settlementsPage.profitTaken);
    expect(container.textContent).not.toContain(en.settlementsPage.profitTaken);
  });

  it('profit taken: its own column and card line, and an owed payout shows 0 with what he owes (Arabic)', () => {
    const { container } = renderIn('ar', [
      line('1', 'p1', 'PROFIT_SHARE', 10000, partner),
      line('2', 'p1', 'PROFIT_DRAWN', -25000, partner),
      line('3', 'p2', 'PROFIT_SHARE', 5000, {}),
    ]);
    expect([...container.querySelectorAll('th')].map((th) => th.textContent)).toContain(ar.settlementsPage.profitTaken);
    const cards = within(screen.getByTestId('settlement-participants-cards')).getAllByRole('listitem');
    const labels = [...cards[0].querySelectorAll('dt')].map((d) => d.textContent);
    expect(labels).toContain(ar.settlementsPage.profitTaken);
    const owed = within(cards[0]).getByTestId('payout-owed');
    expect(owed.textContent).toContain('15,000.00');
    expect(owed.textContent).toContain('يُخصم من توزيعه القادم');
    // The payout itself reads 0, not -15,000.
    const payout = cards[0].querySelectorAll('dd')[cards[0].querySelectorAll('dd').length - 1];
    expect(payout.querySelector('[data-slot="money"]')!.textContent).toMatch(/^0\.00/);
    // The other participant took nothing: a dash, and no owed note.
    expect(within(cards[1]).queryByTestId('payout-owed')).toBeNull();
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
