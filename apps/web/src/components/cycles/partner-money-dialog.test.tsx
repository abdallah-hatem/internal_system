import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/i18n/locales/en.json';
import ar from '@/i18n/locales/ar.json';
import type { AccountMovement } from '@/components/partners/account-dialogs';
import { PartnerMoneyDialog, type PartnerMoney } from './partner-money-dialog';

/**
 * The Funding card's Details (owner 2026-11-14, from an approved mockup):
 * one partner's money in one cycle. The server owns every figure
 * (`partnerMoney`, read from the pots); these pin what the dialog says about
 * them — production's Abdallah on cycle 2 in both languages, a reversed row
 * struck through and not counted, a contribution entered by hand, nothing at
 * all, and a failed read that can be retried.
 */

const state = vi.hoisted(() => ({
  money: null as unknown as PartnerMoney,
  fail: false,
  reads: 0,
}));

vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string) => {
      if (url === '/cycles/c-2/partner-money/u-a') {
        state.reads += 1;
        if (state.fail) return Promise.reject(Object.assign(new Error('boom'), { response: { status: 500 } }));
        return Promise.resolve({ data: { data: state.money } });
      }
      return Promise.resolve({ data: { data: [] } });
    },
  },
}));

const move = (
  id: string,
  kind: AccountMovement['kind'],
  amountEgp: string,
  occurredOn: string,
  extra: Partial<AccountMovement> = {},
): AccountMovement => ({
  id,
  kind,
  amountEgp,
  signedEgp: kind === 'CONTRIBUTION' || kind === 'WITHDRAWAL' ? `-${amountEgp}` : amountEgp,
  amount: amountEgp,
  currency: 'EGP',
  fxRateToEgp: '1',
  occurredOn,
  cycleId: null,
  cycleCode: null,
  settlementId: null,
  note: null,
  reversedAt: null,
  reversalReason: null,
  ...extra,
});

/** Production's Abdallah on CYC-2026-0002, as the server reads him (db spec "Details: production’s Abdallah"). */
function abdallah(): PartnerMoney {
  return {
    cycleId: 'c-2',
    cycleCode: 'CYC-2026-0002',
    partnerUserId: 'u-a',
    name: 'Abdallah',
    onCycle: true,
    forCycle: {
      movements: [
        move('m1', 'ADVANCE', '50775.00', '2026-10-25', { cycleId: 'c-2', cycleCode: 'CYC-2026-0002', note: 'Paid to Ahmad for the second order' }),
        move('m2', 'ADVANCE', '5225.00', '2026-11-14', { cycleId: 'c-2', cycleCode: 'CYC-2026-0002' }),
      ],
      totalEgp: '56000.00',
    },
    untied: {
      shown: true,
      movements: [
        move('m0', 'ADVANCE', '10000.00', '2026-08-15', {
          note: 'Paid 65,000 for CYC-2026-0001; his share there is 55,000',
        }),
      ],
      netEgp: '10000.00',
      drawnHereEgp: '9862.26',
      otherCyclesEgp: '0.00',
      stillUntiedEgp: '137.74',
      totalEgp: '10000.00',
    },
    totals: {
      availableEgp: '66000.00',
      intoCapitalEgp: '-65862.26',
      leftEgp: '137.74',
      leftForCycleEgp: '0.00',
      leftUntiedEgp: '137.74',
      enteredEgp: '0.00',
      putInEgp: '65862.26',
    },
  };
}

beforeEach(() => {
  state.money = abdallah();
  state.fail = false;
  state.reads = 0;
});
afterEach(() => cleanup());

function wrap(locale: 'en' | 'ar' = 'en', onClose = () => {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === 'ar' ? ar : en} timeZone="Africa/Cairo">
      <QueryClientProvider client={client}>
        <PartnerMoneyDialog cycleId="c-2" cycleCode="CYC-2026-0002" partnerUserId="u-a" name="Abdallah" onClose={onClose} />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/ /g, ' ');
/** A movement row as a computer shows it: the phone's own day line (hidden from sm) left out. */
const rowText = (el: Element) => {
  const copy = el.cloneNode(true) as Element;
  copy.querySelectorAll('[data-testid="money-movement-day"]').forEach((n) => n.remove());
  return text(copy);
};
const amountOf = (testId: string) => text(screen.getByTestId(testId).querySelector('dd'));

describe('production’s Abdallah on cycle 2 (owner 2026-11-14)', () => {
  it('reads 50,775 + 5,225 for this cycle, 10,000 untied, 66,000 available, −65,862.26 into capital, 137.74 left', async () => {
    wrap();
    const dialog = await screen.findByTestId('partner-money-dialog');
    expect(text(dialog)).toContain("Abdallah's money in CYC-2026-0002");
    expect(text(dialog)).toContain('What he paid, and what went into the cycle');
    const forCycle = await screen.findByTestId('money-for-cycle');
    expect(text(forCycle.querySelector('h3'))).toBe('Paid for this cycle56,000.00 EGP');
    const rows = within(forCycle).getAllByTestId('money-movement');
    expect(rows.map(rowText)).toEqual([
      'Oct 25, 2026Paid supplierPaid to Ahmad for the second order50,775.00 EGP',
      'Nov 14, 2026Paid supplier5,225.00 EGP',
    ]);
    const untied = screen.getByTestId('money-untied');
    expect(text(untied.querySelector('h3'))).toBe('From money tied to no cycle10,000.00 EGP');
    expect(rowText(within(untied).getByTestId('money-movement'))).toBe(
      'Aug 15, 2026Paid supplierPaid 65,000 for CYC-2026-0001; his share there is 55,00010,000.00 EGP',
    );
    expect(text(screen.getByTestId('untied-drawn'))).toBe('Drawn into CYC-2026-00029,862.26 EGP');
    expect(text(screen.getByTestId('untied-still'))).toBe('Still in his account, tied to no cycle137.74 EGP');
    expect(screen.queryByTestId('untied-other')).toBeNull();
    expect(amountOf('money-available')).toBe('66,000.00 EGP');
    expect(amountOf('money-into-capital')).toBe('-65,862.26 EGP');
    expect(amountOf('money-left')).toBe('137.74 EGP');
    // Nothing entered by hand: no Entered directly, no Put in line.
    expect(screen.queryByTestId('money-entered')).toBeNull();
    expect(screen.queryByTestId('money-put-in')).toBeNull();
    // All of what is left is untied: no split line.
    expect(screen.queryByTestId('money-left-split')).toBeNull();
  });

  it('reads in Arabic, with Latin digits and the figures left-to-right, and no English left', async () => {
    wrap('ar');
    const dialog = await screen.findByTestId('partner-money-dialog');
    await screen.findByTestId('money-for-cycle');
    expect(text(dialog)).toContain('أموال Abdallah في CYC-2026-0002');
    expect(text(dialog)).toContain(ar.fundingCard.details.subtitle);
    expect(text(screen.getByTestId('money-for-cycle').querySelector('h3'))).toBe(`${ar.fundingCard.details.forCycle}56,000.00 EGP`);
    expect(text(screen.getByTestId('money-untied').querySelector('h3'))).toContain(ar.fundingCard.details.untied);
    expect(text(screen.getAllByTestId('money-movement')[0])).toContain(ar.accounts.kind.ADVANCE);
    expect(text(screen.getByTestId('money-available'))).toBe(`${ar.fundingCard.details.total}66,000.00 EGP`);
    expect(amountOf('money-into-capital')).toBe('-65,862.26 EGP');
    expect(text(screen.getByTestId('money-left'))).toBe(`${ar.fundingCard.details.left}137.74 EGP`);
    // Every amount is an isolated left-to-right run, so the minus stays in front.
    for (const m of dialog.querySelectorAll('[data-slot="money"]')) expect(m.getAttribute('dir')).toBe('ltr');
    // No English label survives (the notes and the code are what was entered).
    const labels = text(dialog)
      .replace(/Paid 65,000 for CYC-2026-0001; his share there is 55,000|Paid to Ahmad for the second order|CYC-2026-0002|Abdallah|EGP/g, '');
    expect(labels).not.toMatch(/[A-Za-z]/);
    expect(labels).not.toMatch(/[٠-٩]/);
  });
});

describe('the edges', () => {
  it('a reversed row is struck through, tagged Reversed, and not in the total', async () => {
    const m = abdallah();
    m.forCycle.movements.push(
      move('m3', 'ADVANCE', '1000.00', '2026-11-01', {
        cycleId: 'c-2',
        reversedAt: '2026-11-02T10:00:00.000Z',
        reversalReason: 'entered twice',
      }),
    );
    state.money = m;
    wrap();
    const rows = within(await screen.findByTestId('money-for-cycle')).getAllByTestId('money-movement');
    const reversed = rows[2];
    expect(reversed.getAttribute('data-reversed')).toBe('true');
    expect(text(within(reversed).getByTestId('money-reversed-tag'))).toBe('Reversed');
    expect(within(reversed).getByTestId('money-reversed-tag').getAttribute('title')).toBe('entered twice');
    expect(reversed.querySelector('[data-slot="money"]')!.className).toContain('line-through');
    expect(rows[0].querySelector('[data-slot="money"]')!.className).not.toContain('line-through');
    // The heading's total is the server's, which leaves it out.
    expect(text(screen.getByTestId('money-for-cycle').querySelector('h3'))).toBe('Paid for this cycle56,000.00 EGP');
  });

  it('a contribution entered by hand shows as Entered directly, and Put in ties to the card’s row', async () => {
    state.money = {
      ...abdallah(),
      forCycle: { movements: [move('m1', 'ADVANCE', '1000.00', '2026-11-01', { cycleId: 'c-2' })], totalEgp: '1000.00' },
      untied: { ...abdallah().untied, shown: false, movements: [] },
      totals: {
        availableEgp: '1000.00',
        intoCapitalEgp: '-600.00',
        leftEgp: '400.00',
        leftForCycleEgp: '400.00',
        leftUntiedEgp: '0.00',
        enteredEgp: '2000.00',
        putInEgp: '3000.00',
      },
    };
    wrap();
    await screen.findByTestId('money-totals');
    expect(screen.queryByTestId('money-untied')).toBeNull();
    expect(amountOf('money-left')).toBe('400.00 EGP');
    expect(text(screen.getByTestId('money-entered'))).toBe(
      'Entered directlyContributed without drawing on his account2,000.00 EGP',
    );
    expect(text(screen.getByTestId('money-put-in'))).toBe('Put in so far3,000.00 EGP');
  });

  it('left split in two when both this cycle’s advances and untied money remain; other cycles’ draws shown', async () => {
    const m = abdallah();
    m.untied = { ...m.untied, otherCyclesEgp: '300.00', stillUntiedEgp: '200.00', drawnHereEgp: '0.00', totalEgp: '200.00' };
    m.totals = { ...m.totals, leftEgp: '1200.00', leftForCycleEgp: '1000.00', leftUntiedEgp: '200.00' };
    state.money = m;
    wrap();
    await screen.findByTestId('money-totals');
    expect(text(screen.getByTestId('money-left-split'))).toBe('1,000.00 EGP for this cycle · 200.00 EGP tied to no cycle');
    expect(text(screen.getByTestId('untied-other'))).toBe('Drawn by other cycles-300.00 EGP');
    expect(screen.queryByTestId('untied-drawn')).toBeNull();
  });

  it.each(['en', 'ar'] as const)('a partner with nothing on this cycle reads an empty state, not a column of zeros (%s)', async (locale) => {
    state.money = {
      ...abdallah(),
      forCycle: { movements: [], totalEgp: '0.00' },
      untied: { ...abdallah().untied, shown: false, movements: [], totalEgp: '0.00' },
      totals: { availableEgp: '0.00', intoCapitalEgp: '0.00', leftEgp: '0.00', leftForCycleEgp: '0.00', leftUntiedEgp: '0.00', enteredEgp: '0.00', putInEgp: '0.00' },
    };
    wrap(locale);
    const messages = locale === 'ar' ? ar : en;
    expect(await screen.findByText(messages.fundingCard.details.empty)).toBeTruthy();
    expect(screen.queryByTestId('money-totals')).toBeNull();
  });

  it('a failed read says so and can be retried; Close closes', async () => {
    state.fail = true;
    const onClose = vi.fn();
    wrap('en', onClose);
    expect(await screen.findByText(en.fundingCard.details.loadFailed)).toBeTruthy();
    state.fail = false;
    fireEvent.click(screen.getByRole('button', { name: en.fundingCard.details.retry }));
    await screen.findByTestId('money-totals');
    expect(state.reads).toBe(2);
    fireEvent.click(document.querySelector('[data-dialog-footer] button')!);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    // The footer's only button is Close, and it never submits.
    expect(document.querySelector('[data-dialog-footer] button')!.getAttribute('type')).toBe('button');
  });
});
