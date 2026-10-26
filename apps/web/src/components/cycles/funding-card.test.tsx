import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/i18n/locales/en.json';
import ar from '@/i18n/locales/ar.json';
import { ToastProvider } from '@/components/ui/toast';
import { FundingCard, type AccountFunding, type CardParticipant } from './funding-card';
import type { FundingTotals } from './funding-note';

/**
 * The cycle page's one Funding card (BUSINESS_LOGIC §8, owner 2026-10-26,
 * from a rendered sample: "build it like this"). The server owns every
 * figure; these pin what the card says about them — the three sections in
 * order, production's cycle 2 read the way the owner would read it, the lock
 * switching every control off with the reason, and the forms it opens
 * starting clean the second time.
 */

const state = vi.hoisted(() => ({
  funding: null as unknown as AccountFunding,
  get: 'ok' as 'ok' | 'never' | 'fail',
  posts: [] as Array<{ url: string; body: unknown }>,
  puts: [] as Array<{ url: string; body: unknown }>,
}));

vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ user: { id: 'u-a', email: 'abdallah@motoparts.com', role: 'CORE_PARTNER' }, isLoading: false }),
}));
vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string) => {
      if (url === '/cycles/c-2/account-funding') {
        if (state.get === 'never') return new Promise(() => {});
        if (state.get === 'fail') return Promise.reject(new Error('network'));
        return Promise.resolve({ data: { data: state.funding } });
      }
      if (url === '/currency-rates/map') return Promise.resolve({ data: { data: { USD: 50 } } });
      return Promise.resolve({ data: { data: [] } });
    },
    post: (url: string, body: unknown) => {
      state.posts.push({ url, body });
      return Promise.resolve({ data: { data: { totalEgp: String((body as { totalEgp?: number }).totalEgp ?? 0), lines: [] } } });
    },
    put: (url: string, body: unknown) => {
      state.puts.push({ url, body });
      return Promise.resolve({ data: { data: {} } });
    },
  },
}));

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

const advance = (id: string, amountEgp: string, occurredOn = '2026-10-20') => ({
  id,
  kind: 'ADVANCE' as const,
  amountEgp,
  signedEgp: amountEgp,
  amount: amountEgp,
  currency: 'EGP',
  fxRateToEgp: '1',
  occurredOn,
  cycleId: 'c-2',
  cycleCode: 'CYC-2026-0002',
  settlementId: null,
  note: null,
  reversedAt: null,
  reversalReason: null,
});

const partnerRow = (id: string, name: string, share: string, available: string, cover: string, contribution = '0.00') => ({
  partnerUserId: `u-${id}`,
  participantId: `p-${id}`,
  name,
  shareEgp: share,
  stillToGiveEgp: share,
  coverEgp: cover,
  availableEgp: available,
  ownAdvancesEgp: available,
  untiedEgp: '0.00',
  elsewhereEgp: '0.00',
  balanceEgp: available,
  contributionEgp: contribution,
  fromAccountEgp: '0.00',
});

const person = (id: string, name: string, contribution = '0', type = 'CORE_PARTNER'): CardParticipant => ({
  id: `p-${id}`,
  participantType: type,
  contributionAmount: contribution,
  customProfitPct: null,
  partner: type === 'CORE_PARTNER' ? { email: `${id}@motoparts.com`, partner: { displayName: name } } : null,
  investor: type === 'CORE_PARTNER' ? null : { email: `${id}@x.test`, partner: { displayName: name } },
});

let cycleParticipants: CardParticipant[];
let totals: FundingTotals;

/**
 * Production on 2026-10-26: CYC-2026-0002, Abdallah advanced 50,775 and
 * Shady 10,000, Fares nothing; a target of 120,000 — thirds of 40,000.
 */
function cycleTwo(): AccountFunding {
  return {
    cycleId: 'c-2',
    code: 'CYC-2026-0002',
    status: 'PURCHASING',
    currency: 'EGP',
    fundingLock: null,
    closed: false,
    target: { amount: '120000.00', currency: 'EGP', fxRateToEgp: '1', amountEgp: '120000.00' },
    paidSoFar: {
      totalEgp: '60775.00',
      inTargetCurrency: '60775.00',
      byPartner: [
        { partnerUserId: 'u-a', name: 'Abdallah', totalEgp: '50775.00', inTargetCurrency: '50775.00', intoCapitalEgp: '0.00', advances: [advance('a1', '50775.00')] },
        {
          partnerUserId: 'u-s',
          name: 'Shady',
          totalEgp: '10000.00',
          inTargetCurrency: '10000.00',
          intoCapitalEgp: '0.00',
          advances: [advance('s1', '6000.00', '2026-10-18'), advance('s2', '4000.00', '2026-10-21')],
        },
      ],
    },
    partners: [
      partnerRow('a', 'Abdallah', '40000.00', '50775.00', '10775.00'),
      partnerRow('s', 'Shady', '40000.00', '10000.00', '-30000.00'),
      partnerRow('f', 'Fares', '40000.00', '0.00', '-40000.00'),
    ],
    toFundEgp: '95000.00',
    investorsEgp: '0.00',
    partnersContributedEgp: '0.00',
    stillToContributeEgp: '95000.00',
    shares: { basis: 'TARGET', ofEgp: '120000.00', partnersEgp: '120000.00', stillEgp: '120000.00' },
    participants: [
      { participantId: 'p-a', participantType: 'CORE_PARTNER', name: 'Abdallah', contributionEgp: '0.00', customProfitPct: null, investorFeePct: null, profitPct: null },
      { participantId: 'p-s', participantType: 'CORE_PARTNER', name: 'Shady', contributionEgp: '0.00', customProfitPct: null, investorFeePct: null, profitPct: null },
      { participantId: 'p-f', participantType: 'CORE_PARTNER', name: 'Fares', contributionEgp: '0.00', customProfitPct: null, investorFeePct: null, profitPct: null },
    ],
    profitSplit: { basis: 'NONE', equal: false, problem: null },
  };
}

beforeEach(() => {
  state.funding = cycleTwo();
  state.get = 'ok';
  state.posts = [];
  state.puts = [];
  cycleParticipants = [person('a', 'Abdallah'), person('s', 'Shady'), person('f', 'Fares')];
  totals = { profitBasis: 'NONE', cycleCostEgp: '95000.00', landedEgp: '95000.00', transferredInEgp: '0.00', toFundEgp: '95000.00', lenderFinancedEgp: '0.00' };
});
afterEach(() => cleanup());

function wrap(locale: 'en' | 'ar' = 'en', opts: { lenders?: string[]; onPaidByLender?: () => void } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return {
    client,
    ...render(
      <NextIntlClientProvider locale={locale} messages={locale === 'ar' ? ar : en} timeZone="Africa/Cairo">
        <QueryClientProvider client={client}>
          <ToastProvider>
            <FundingCard
              cycle={{
                id: 'c-2',
                code: state.funding.code,
                status: state.funding.status,
                currency: 'EGP',
                fundingLock: state.funding.fundingLock,
                participants: cycleParticipants,
              }}
              totals={totals}
              lenderNames={opts.lenders ?? []}
              canFinance
              onPaidByLender={opts.onPaidByLender ?? (() => {})}
            />
          </ToastProvider>
        </QueryClientProvider>
      </NextIntlClientProvider>,
    ),
  };
}

const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/ /g, ' ');
const rowsOf = (testId: string) => screen.getAllByTestId(testId);
function typeInto(input: HTMLInputElement, value: string) {
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
}

describe('one Funding card, three sections in order', () => {
  it('target and paid so far, then contributions, then the profit split and who is on the cycle', async () => {
    wrap();
    const card = await screen.findByTestId('funding-card');
    const paid = within(card).getByTestId('funding-paid');
    const contributions = within(card).getByTestId('funding-contributions');
    const split = within(card).getByTestId('funding-split');
    expect(paid.compareDocumentPosition(contributions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(contributions.compareDocumentPosition(split) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Every button inside says it is a button: the card sits on a page with forms (CLAUDE.md §13).
    for (const b of within(card).getAllByRole('button')) expect(b.getAttribute('type')).toBe('button');
  });
});

describe('production’s cycle 2 (2026-10-26)', () => {
  it('reads 60,775 paid of a 120,000 target, with the bar, and each partner’s payments — Fares with a dash', async () => {
    wrap();
    expect(text(await screen.findByTestId('paid-of-target'))).toBe('60,775.00 EGP paid so far · 59,225.00 EGP to go');
    expect(screen.getByTestId('funding-progress').getAttribute('aria-valuenow')).toBe('50');
    expect(text(screen.getByTestId('funding-target'))).toContain('Target 120,000.00 EGP');
    const rows = rowsOf('paid-row');
    expect(rows).toHaveLength(3);
    expect(text(rows[0])).toContain('Abdallah');
    expect(text(within(rows[0]).getByTestId('paid-amount'))).toBe('50,775.00 EGP');
    expect(text(rows[0])).toContain('Oct 20, 2026');
    // Several payments: their count, not one day.
    expect(text(rows[1])).toContain('2 payments');
    expect(text(within(rows[2]).getByTestId('paid-amount'))).toBe('—');
    expect(text(within(rows[2]).getByTestId('paid-into-capital'))).toBe('');
    expect(screen.getByTestId('record-advance').textContent).toContain(en.fundingCard.recordWhatIPaid);
  });

  it('thirds of the target, 40,000 each: Abdallah covered with 10,775 over, Shady 30,000 short, Fares 40,000 short', async () => {
    wrap();
    const contributions = await screen.findByTestId('funding-contributions');
    expect(text(contributions.querySelector('h3'))).toBe('Contributions — equal thirds of the target, 120,000.00 EGP');
    const rows = within(contributions).getAllByTestId('share-row');
    expect(rows.map((r) => text(within(r).getByTestId('share-amount')))).toEqual(['40,000.00 EGP', '40,000.00 EGP', '40,000.00 EGP']);
    expect(rows.map((r) => text(within(r).getByTestId('share-available')))).toEqual(['50,775.00 EGP', '10,000.00 EGP', '0.00 EGP']);
    const pills = rows.map((r) => within(r).getByTestId('share-status'));
    expect(pills.map(text)).toEqual(['covered · 10,775.00 EGP left over', '30,000.00 EGP short', '40,000.00 EGP short']);
    expect(pills.map((p) => p.getAttribute('data-short'))).toEqual(['false', 'true', 'true']);
  });

  it('into capital: what his contributions drew from what he paid here', async () => {
    state.funding.paidSoFar.byPartner[0].intoCapitalEgp = '40000.00';
    wrap();
    const rows = await screen.findAllByTestId('paid-row');
    expect(text(within(rows[0]).getByTestId('paid-into-capital'))).toContain('40,000.00 EGP');
    // Paid, none of it drawn yet: a dash, not a zero that looks like a figure.
    expect(text(within(rows[1]).getByTestId('paid-into-capital'))).toContain('—');
  });

  it('nothing contributed yet: the split says settling is refused, and names who is on the cycle', async () => {
    wrap();
    expect(text(await screen.findByTestId('profit-split-line'))).toBe(en.fundingCard.splitNone);
    expect(text(screen.getByTestId('on-cycle'))).toBe('On this cycle: Abdallah, Shady, and Fares');
  });

  it('equal contributions read as equal thirds, 33.33 / 33.33 / 33.34', async () => {
    state.funding.profitSplit = { basis: 'CONTRIBUTIONS', equal: true, problem: null };
    state.funding.participants = state.funding.participants.map((p, i) => ({ ...p, profitPct: i === 2 ? '33.34' : '33.33' }));
    wrap();
    expect(text(await screen.findByTestId('profit-split-line'))).toBe('Equal thirds (33.33 / 33.33 / 33.34)');
  });
});

describe('no target, a friend paid, an investor', () => {
  it('no target: no bar — the paid line alone — and the shares are of the cost to fund', async () => {
    state.funding.target = null;
    state.funding.paidSoFar.inTargetCurrency = null;
    state.funding.shares = { basis: 'COST_TO_FUND', ofEgp: '95000.00', partnersEgp: '95000.00', stillEgp: '95000.00' };
    wrap();
    expect(text(await screen.findByTestId('paid-so-far'))).toBe('60,775.00 EGP paid so far');
    expect(screen.queryByTestId('funding-progress')).toBeNull();
    expect(screen.queryByTestId('paid-of-target')).toBeNull();
    expect(text(screen.getByTestId('funding-target'))).toContain(en.accounts.noTarget);
    expect(text(screen.getByTestId('funding-contributions').querySelector('h3'))).toBe(
      'Contributions — equal thirds of the cost to fund, 95,000.00 EGP',
    );
  });

  it('a friend paid it all: one line at the top names him and asks who repays him; his payment is offered from it', async () => {
    totals = { ...totals, lenderFinancedEgp: '95000.00' };
    const onPaidByLender = vi.fn();
    wrap('en', { lenders: ['Ahmad Eraiby'], onPaidByLender });
    const note = await screen.findByTestId('funding-note');
    expect(screen.getByTestId('funding-card').contains(note)).toBe(true);
    expect(text(within(note).getByTestId('funding-note-title'))).toBe(
      'Ahmad Eraiby paid 95,000.00 EGP for this cycle. Split who repays him between the partners.',
    );
    fireEvent.click(within(note).getByTestId('funding-note-lender'));
    expect(onPaidByLender).toHaveBeenCalledOnce();
  });

  it('a friend paid and the partners entered their shares: each one’s share of repaying him', async () => {
    totals = { ...totals, profitBasis: 'CONTRIBUTIONS', lenderFinancedEgp: '95000.00' };
    cycleParticipants = [person('a', 'Abdallah', '28500'), person('s', 'Shady', '28500'), person('f', 'Fares', '38000')];
    wrap('en', { lenders: ['Ahmad Eraiby'] });
    expect(screen.queryByTestId('funding-note')).toBeNull();
    const shares = await screen.findByTestId('repay-shares');
    expect(text(shares)).toContain("Each partner's share of repaying Ahmad Eraiby:");
    expect(text(screen.getByTestId('repay-share-p-f'))).toBe('Fares 38,000.00 EGP (40%)');
  });

  it('an investor keeps his own contribution row, with no share and no status', async () => {
    state.funding.participants.push({
      participantId: 'p-i', participantType: 'TEMP_INVESTOR', name: 'Karim', contributionEgp: '20000.00', customProfitPct: null, investorFeePct: '15.00', profitPct: null,
    });
    wrap();
    const row = await screen.findByTestId('investor-row');
    expect(text(row)).toContain('Karim');
    expect(text(row)).toContain('20,000.00 EGP');
    expect(text(row)).toContain('fee 15%');
    expect(within(row).queryByTestId('share-status')).toBeNull();
  });
});

describe('the funding lock (§8, 2026-10-18)', () => {
  it('approved: every control in the card is off, each saying why, and the reason sits at the top', async () => {
    state.funding.fundingLock = 'SETTLEMENT_APPROVED';
    state.funding.status = 'SETTLEMENT';
    state.funding.closed = true;
    wrap();
    const reason = en.cycles.fundingLocked.replace('{reason}', en.codes.fundingLock.SETTLEMENT_APPROVED);
    expect(text(await screen.findByTestId('funding-locked'))).toBe(reason);
    const ids = ['edit-funding-target', 'record-advance', 'contribute-thirds', 'enter-amounts', 'split-equally', 'change-split', 'add-investor'];
    for (const id of ids) {
      const b = screen.getByTestId(id) as HTMLButtonElement;
      expect([id, b.disabled]).toEqual([id, true]);
      expect([id, b.getAttribute('title')]).toEqual([id, reason]);
    }
  });

  it('being settled but not yet approved: the accounts are closed to it, entering contributions by hand is not', async () => {
    state.funding.status = 'SETTLEMENT';
    state.funding.closed = true;
    wrap();
    const said = await screen.findByTestId('funding-locked');
    expect(text(said)).toContain('can no longer change');
    for (const id of ['record-advance', 'contribute-thirds', 'edit-funding-target']) {
      expect((screen.getByTestId(id) as HTMLButtonElement).disabled).toBe(true);
    }
    for (const id of ['enter-amounts', 'split-equally', 'change-split', 'add-investor']) {
      expect((screen.getByTestId(id) as HTMLButtonElement).disabled).toBe(false);
    }
  });
});

describe('the forms it opens', () => {
  it('Contribute equal thirds: the total starts at what is still to give; a short partner stops it; a smaller total goes', async () => {
    wrap();
    fireEvent.click(await screen.findByTestId('contribute-thirds'));
    const dialog = await screen.findByTestId('contribute-dialog');
    const total = dialog.querySelector<HTMLInputElement>('#contribute-total')!;
    expect(total.value.replace(/,/g, '')).toBe('120000.00');
    const submit = within(dialog).getByRole('button', { name: /^Contribute/ });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    expect(within(dialog).getAllByTestId('contribute-short')).toHaveLength(2);
    typeInto(total, '0.02');
    // 0.02 among three: the last takes the odd piastres; nobody is short.
    expect(within(dialog).getAllByTestId('contribute-share').map(text)).toEqual(['0.00 EGP', '0.00 EGP', '0.02 EGP']);
    typeInto(total, '0');
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    // Fares has nothing this cycle can draw, so any real total stops at him.
    typeInto(total, '3');
    expect(within(dialog).getAllByTestId('contribute-short')).toHaveLength(1);
    state.funding.partners[2].availableEgp = '1.00';
    cleanup();
    wrap();
    fireEvent.click(await screen.findByTestId('contribute-thirds'));
    const again = await screen.findByTestId('contribute-dialog');
    typeInto(again.querySelector<HTMLInputElement>('#contribute-total')!, '3');
    fireEvent.click(within(again).getByRole('button', { name: /^Contribute/ }));
    await waitFor(() => expect(state.posts).toEqual([{ url: '/cycles/c-2/account-contributions', body: { totalEgp: 3 } }]));
  });

  it('a total he typed is never overwritten when the figures refresh underneath', async () => {
    const { client } = wrap();
    fireEvent.click(await screen.findByTestId('contribute-thirds'));
    const dialog = await screen.findByTestId('contribute-dialog');
    const total = dialog.querySelector<HTMLInputElement>('#contribute-total')!;
    typeInto(total, '300');
    state.funding = { ...state.funding, shares: { ...state.funding.shares, stillEgp: '900.00' } };
    await client.invalidateQueries({ queryKey: ['account-funding'] });
    await waitFor(() => expect(within(dialog).getAllByTestId('contribute-share').map(text)).toEqual(['100.00 EGP', '100.00 EGP', '100.00 EGP']));
    expect(total.value).toBe('300');
  });

  it('Enter amounts opens the amounts form on what is recorded; the second time, what was typed and cancelled is gone', async () => {
    cycleParticipants = [person('a', 'Abdallah', '6000'), person('s', 'Shady', '4000'), person('f', 'Fares')];
    wrap();
    fireEvent.click(await screen.findByTestId('enter-amounts'));
    let form = await screen.findByTestId('amounts-form');
    const amounts = () =>
      [...screen.getByTestId('amounts-form').querySelectorAll<HTMLInputElement>('input[data-field^="contribution-"]')].map((i) => i.value.replace(/,/g, ''));
    expect(amounts()).toEqual(['6000.00', '4000.00', '']);
    typeInto(form.querySelector<HTMLInputElement>('input[data-field="contribution-p-f"]')!, '999');
    fireEvent.click(within(form).getByRole('button', { name: en.common.cancel }));
    expect(screen.queryByTestId('amounts-form')).toBeNull();
    fireEvent.click(screen.getByTestId('enter-amounts'));
    form = await screen.findByTestId('amounts-form');
    expect(amounts()).toEqual(['6000.00', '4000.00', '']);
    expect(state.puts).toEqual([]);
  });

  it('Change split opens on what is agreed; Save waits for 100; the second time it starts from what is recorded', async () => {
    wrap();
    fireEvent.click(await screen.findByTestId('change-split'));
    let dialog = await screen.findByTestId('split-dialog');
    const field = (id: string) => screen.getByTestId('split-dialog').querySelector<HTMLInputElement>(`input[data-field="split-${id}"]`)!;
    const save = () => within(screen.getByTestId('split-dialog')).getByRole('button', { name: en.common.save }) as HTMLButtonElement;
    expect(['p-a', 'p-s', 'p-f'].map((id) => field(id).value)).toEqual(['', '', '']);
    typeInto(field('p-a'), '30');
    typeInto(field('p-s'), '30');
    // Two of three: settling would refuse a partial split, so Save waits.
    expect(save().disabled).toBe(true);
    typeInto(field('p-f'), '30');
    expect(text(within(dialog).getByTestId('split-total'))).toContain('90.00%');
    expect(save().disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole('button', { name: en.common.cancel }));
    expect(screen.queryByTestId('split-dialog')).toBeNull();
    fireEvent.click(screen.getByTestId('change-split'));
    dialog = await screen.findByTestId('split-dialog');
    expect(['p-a', 'p-s', 'p-f'].map((id) => field(id).value)).toEqual(['', '', '']);
    typeInto(field('p-a'), '30');
    typeInto(field('p-s'), '30');
    typeInto(field('p-f'), '40');
    expect(save().disabled).toBe(false);
    fireEvent.click(save());
    await waitFor(() => expect(state.puts).toHaveLength(3));
    expect(state.puts).toEqual([
      { url: '/cycles/participants/p-a', body: { customProfitPct: 30 } },
      { url: '/cycles/participants/p-s', body: { customProfitPct: 30 } },
      { url: '/cycles/participants/p-f', body: { customProfitPct: 40 } },
    ]);
  });

  it('Split by contribution clears an agreed split: each percentage written back as none', async () => {
    state.funding.profitSplit = { basis: 'CUSTOM_SPLIT', equal: false, problem: null };
    state.funding.participants = state.funding.participants.map((p, i) => ({ ...p, customProfitPct: ['30.00', '30.00', '40.00'][i], profitPct: ['30.00', '30.00', '40.00'][i] }));
    wrap();
    expect(text(await screen.findByTestId('profit-split-line'))).toBe('Agreed split (30 / 30 / 40)');
    fireEvent.click(screen.getByTestId('change-split'));
    const dialog = await screen.findByTestId('split-dialog');
    fireEvent.click(within(dialog).getByTestId('split-clear'));
    fireEvent.click(within(dialog).getByRole('button', { name: en.common.save }));
    await waitFor(() => expect(state.puts).toHaveLength(3));
    expect(state.puts.map((p) => p.body)).toEqual([{ customProfitPct: null }, { customProfitPct: null }, { customProfitPct: null }]);
  });

  it('Add investor opens the participant form on the investor type; Cancel closes it', async () => {
    wrap();
    fireEvent.click(await screen.findByTestId('add-investor'));
    const form = await screen.findByTestId('add-participant-form');
    expect(document.querySelector<HTMLInputElement>('input[type="hidden"][name="participantType"]')!.value).toBe('TEMP_INVESTOR');
    fireEvent.click(within(form).getByRole('button', { name: en.common.cancel }));
    expect(screen.queryByTestId('add-participant-form')).toBeNull();
  });
});

describe('while it loads, if it cannot, and in Arabic', () => {
  it('a skeleton in the card’s shape: its three sections’ rows, no figures', async () => {
    state.get = 'never';
    wrap();
    const skeleton = await screen.findByTestId('funding-card-skeleton');
    expect(screen.getByTestId('funding-card-loading')).toBeTruthy();
    expect(within(skeleton).getAllByTestId('skeleton-row')).toHaveLength(6);
    expect(screen.queryByTestId('funding-card')).toBeNull();
  });

  it('says it could not load, and loads again on Try again', async () => {
    state.get = 'fail';
    wrap();
    expect(text(await screen.findByTestId('funding-card-error'))).toContain(en.accounts.fundingLoadFailed);
    state.get = 'ok';
    fireEvent.click(screen.getByRole('button', { name: en.accounts.retry }));
    expect(await screen.findByTestId('funding-card')).toBeTruthy();
  });

  it('reads in Arabic with no key left untranslated, the figures kept left-to-right', async () => {
    wrap('ar');
    const card = await screen.findByTestId('funding-card');
    expect(card.textContent).not.toMatch(/(fundingCard|accounts|cycles)\.[a-zA-Z]/);
    expect(text(card.querySelector('[data-testid="funding-contributions"] h3'))).toContain('أثلاث متساوية');
    const pill = screen.getAllByTestId('share-status')[1];
    expect(text(pill)).toContain('ينقصه');
    expect(pill.querySelector('[data-slot="money"]')?.getAttribute('dir')).toBe('ltr');
  });
});
