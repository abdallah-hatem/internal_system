import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Prisma } from '../../../../api/node_modules/@prisma/client';
import en from '@/i18n/locales/en.json';
import ar from '@/i18n/locales/ar.json';
import { ToastProvider } from '@/components/ui/toast';
import { businessToday } from '@/lib/dates';
import * as server from '../../../../api/src/common/take-money';
import { TakeMoneyCard, splitTake, type TakeMoneyView } from './take-money-card';

/**
 * "Take money from this cycle" (BUSINESS_LOGIC §8, owner 2026-11-10): one card
 * for profit taken and capital taken back. The server owns every figure and
 * rule; these pin what the card says, that the dialog shows the cut — profit
 * first, then capital — before Take is pressed, that a value the reader typed
 * is never overwritten, that the limit is said before asking, that the
 * server's refusal reaches the reader, and that a locked cycle offers nothing.
 */

type Refusal = { code: string; message: string; params?: Record<string, unknown> };

const state = vi.hoisted(() => ({
  view: null as unknown as TakeMoneyView,
  userId: 'u-a',
  reads: 0,
  posts: [] as Array<{ url: string; body: unknown }>,
  /** A coded refusal the next POST answers with. */
  refusal: null as null | Refusal,
  /** POSTs never answer: a save in flight. */
  hang: false,
}));

vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ user: { id: state.userId, email: 'abdallah@motoparts.com', role: 'CORE_PARTNER' }, isLoading: false }),
}));
vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string) => {
      if (url === '/cycles/c-1/take') {
        state.reads += 1;
        return Promise.resolve({ data: { data: state.view } });
      }
      return Promise.resolve({ data: { data: [] } });
    },
    post: (url: string, body: unknown) => {
      state.posts.push({ url, body });
      if (state.hang) return new Promise(() => {});
      if (state.refusal) {
        const error = state.refusal;
        state.refusal = null;
        return Promise.reject(
          Object.assign(new Error(error.message), { isAxiosError: true, response: { status: 400, data: { error } } }),
        );
      }
      return Promise.resolve({ data: { data: { takenOn: businessToday() } } });
    },
  },
}));

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
});

const taken = (id: string, kind: 'PROFIT' | 'CAPITAL', who: string, name: string, amount: string, extra: Partial<TakeMoneyView['taken'][number]> = {}) => ({
  id,
  kind,
  userId: `u-${who}`,
  name,
  amountEgp: amount,
  takenOn: '2026-11-01',
  note: null,
  createdAt: '2026-11-01T10:00:00Z',
  reversedAt: null,
  reversalReason: null,
  settled: false,
  ...extra,
});

/**
 * Abdallah: 20,000 profit and 40,000 capital he can take (60,000 in all), owes
 * 1,500; Setta, an investor: 14,000 of capital and no profit share.
 */
function fixture(over: Partial<TakeMoneyView> = {}): TakeMoneyView {
  return {
    cycleId: 'c-1',
    cycleCode: 'CYC-2026-0001',
    locked: null,
    problem: null,
    profitEgp: '90000.00',
    sharePaidPct: '50.00',
    collectedProfitEgp: '45000.00',
    toFundEgp: '200000.00',
    recoveredEgp: '140000.00',
    recoveredPct: '70.00',
    people: [
      {
        userId: 'u-a',
        name: 'Abdallah',
        participantType: 'CORE_PARTNER',
        profit: { sharePct: '50.0000', shareOfCollectedEgp: '22500.00', takenEgp: '1000.00', owedEgp: '1500.00', availableEgp: '20000.00' },
        capital: { contributionEgp: '55000.00', recoveredEgp: '40000.00', takenEgp: '0.00', availableEgp: '40000.00' },
        availableEgp: '60000.00',
      },
      {
        userId: 'u-m',
        name: 'Setta',
        participantType: 'TEMP_INVESTOR',
        profit: null,
        capital: { contributionEgp: '20000.00', recoveredEgp: '14000.00', takenEgp: '0.00', availableEgp: '14000.00' },
        availableEgp: '14000.00',
      },
    ],
    taken: [
      taken('t-1', 'PROFIT', 'a', 'Abdallah', '1000.00'),
      taken('t-2', 'CAPITAL', 'm', 'Setta', '500.00', { reversedAt: '2026-11-02T10:00:00Z', reversalReason: 'typed twice' }),
      taken('t-3', 'CAPITAL', 'a', 'Abdallah', '2000.00', { settled: true }),
    ],
    ...over,
  };
}

beforeEach(() => {
  state.view = fixture();
  state.userId = 'u-a';
  state.reads = 0;
  state.posts = [];
  state.refusal = null;
  state.hang = false;
});
afterEach(cleanup);

function wrap(locale: 'en' | 'ar' = 'en') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === 'ar' ? ar : en} timeZone="Africa/Cairo">
      <QueryClientProvider client={client}>
        <ToastProvider>
          <TakeMoneyCard cycleId="c-1" />
        </ToastProvider>
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/ /g, ' ');
const rowOf = (id: string) =>
  screen.getAllByTestId('take-person').find((r) => r.getAttribute('data-person') === `u-${id}`)!;
const takenRow = (id: string) => screen.getAllByTestId('taken-row').find((r) => r.getAttribute('data-taken') === id)!;
const dialog = () => screen.getByTestId('take-money-dialog');
const amountInput = () => dialog().querySelector<HTMLInputElement>('#take-money-amount')!;
function typeInto(input: HTMLInputElement, value: string) {
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
}
const submitTake = (label = en.takeMoney.take) => fireEvent.click(within(dialog()).getByRole('button', { name: label }));
async function openTake() {
  fireEvent.click(await screen.findByTestId('take-money'));
  return screen.findByTestId('take-money-dialog');
}

describe('the card reads the server’s figures', () => {
  it('per person: profit and capital he can take, taken so far, and the total — the investor without a profit share', async () => {
    wrap();
    const card = await screen.findByTestId('take-money-card');
    expect(text(within(card).getByTestId('take-money-collected'))).toBe('45,000.00 EGP');
    expect(text(within(card).getByTestId('take-money-recovered'))).toBe('70%');
    expect(text(card)).toContain('140,000.00 EGP of 200,000.00 EGP');
    const a = rowOf('a');
    expect(text(within(a).getByTestId('take-profit-room'))).toBe('20,000.00 EGP');
    expect(text(within(a).getByTestId('take-capital-room'))).toBe('40,000.00 EGP');
    expect(text(within(a).getByTestId('take-taken'))).toBe('Profit 1,000.00 EGPCapital 0.00 EGP');
    expect(text(within(a).getByTestId('take-total'))).toBe('60,000.00 EGP');
    expect(text(within(a).getByTestId('take-owes'))).toBe('Owes 1,500.00 EGP from an earlier payout');
    const m = rowOf('m');
    expect(m.textContent).toContain(en.takeMoney.investor);
    expect(text(within(m).getByTestId('take-profit-room'))).toBe(en.takeMoney.noProfitShare);
    expect(text(within(m).getByTestId('take-taken'))).toBe('Capital 0.00 EGP');
    expect(text(within(m).getByTestId('take-total'))).toBe('14,000.00 EGP');
  });

  it('one history: each row labelled profit or capital; undone struck through with its reason; settled marked; Undo only on what stands', async () => {
    wrap();
    await screen.findByTestId('take-money-card');
    expect(text(within(takenRow('t-1')).getByTestId('taken-kind'))).toBe(en.takeMoney.kindPROFIT);
    expect(text(within(takenRow('t-2')).getByTestId('taken-kind'))).toBe(en.takeMoney.kindCAPITAL);
    expect(text(within(takenRow('t-2')).getByTestId('taken-reversed'))).toBe('Undone: typed twice');
    expect(within(takenRow('t-2')).queryByTestId('undo-taken')).toBeNull();
    expect(text(within(takenRow('t-3')).getByTestId('taken-settled'))).toBe(en.takeMoney.settledCAPITAL);
    expect(within(takenRow('t-3')).queryByTestId('undo-taken')).toBeNull();
    expect(within(takenRow('t-1')).getByTestId('undo-taken')).toBeTruthy();
    // Inside a page with forms: no button here may submit one.
    for (const b of within(screen.getByTestId('take-money-card')).getAllByRole('button')) {
      expect(b.getAttribute('type')).toBe('button');
    }
  });

  it('Arabic: no English left, amounts left-to-right', async () => {
    wrap('ar');
    const card = await screen.findByTestId('take-money-card');
    expect(card.textContent).toContain(ar.takeMoney.title);
    expect(card.textContent).toContain(ar.takeMoney.kindCAPITAL);
    for (const word of [en.takeMoney.title, en.takeMoney.colTotal, en.takeMoney.take, 'Investor', 'Undone', 'Profit', 'Capital']) {
      expect(card.textContent).not.toContain(word);
    }
    for (const m of card.querySelectorAll('[data-slot="money"]')) expect(m.getAttribute('dir')).toBe('ltr');
  });

  it('nothing taken, nobody on the cycle: says so', async () => {
    state.view = fixture({ people: [], taken: [] });
    wrap();
    const card = await screen.findByTestId('take-money-card');
    expect(card.textContent).toContain(en.takeMoney.noPeople);
    expect(card.textContent).toContain(en.takeMoney.noneYet);
    expect(within(card).queryByTestId('take-money')).toBeNull();
  });
});

describe('locked or not yet possible', () => {
  it('approved settlement: no Take, no Undo, and why', async () => {
    state.view = fixture({ locked: 'SETTLEMENT_APPROVED' });
    wrap();
    const card = await screen.findByTestId('take-money-card');
    expect(within(card).queryByTestId('take-money')).toBeNull();
    expect(within(card).queryAllByTestId('undo-taken')).toHaveLength(0);
    expect(text(within(card).getByTestId('take-money-locked'))).toBe(
      en.takeMoney.locked.replace('{reason}', en.codes.profitDrawLock.SETTLEMENT_APPROVED),
    );
  });

  it('a closed cycle says so in Arabic, never the raw status', async () => {
    state.view = fixture({ locked: 'CLOSED' });
    wrap('ar');
    const locked = await screen.findByTestId('take-money-locked');
    expect(locked.textContent).toContain(ar.codes.profitDrawLock.CLOSED);
    expect(locked.textContent).not.toContain('CLOSED');
  });

  it('no split yet: says no profit can be taken — capital still can', async () => {
    const people = fixture().people.map((p) => ({ ...p, profit: p.profit && { ...p.profit, availableEgp: '0.00' }, availableEgp: p.capital.availableEgp }));
    state.view = fixture({ problem: 'CYCLE_NOT_FUNDED', profitEgp: null, collectedProfitEgp: '0.00', people });
    wrap();
    expect(text(await screen.findByTestId('take-money-problem'))).toBe(en.takeMoney.problem);
    await openTake();
    typeInto(amountInput(), '100');
    expect(text(within(dialog()).getByTestId('take-split'))).toBe('This take is100.00 EGP capital');
  });

  it('a read that fails says so with a retry, not a blank card', async () => {
    state.view = { data: [] } as unknown as TakeMoneyView;
    wrap();
    expect(await screen.findByTestId('take-money-error')).toBeTruthy();
  });
});

describe('Take', () => {
  it('defaults to the signed-in partner, with his rooms and his total as the max', async () => {
    wrap();
    const d = await openTake();
    expect(d.querySelector<HTMLInputElement>('input[name="person"]')!.value).toBe('u-a');
    expect(text(within(d).getByTestId('take-rooms'))).toBe('Profit 20,000.00 EGP · Capital 40,000.00 EGP');
    expect(text(within(d).getByTestId('take-money-max'))).toBe('Max 60,000.00 EGP');
    expect(within(d).queryByTestId('take-split')).toBeNull();
  });

  it('someone not on this cycle gets no default — he picks', async () => {
    state.userId = 'u-other';
    wrap();
    const d = await openTake();
    expect(d.querySelector<HTMLInputElement>('input[name="person"]')!.value).toBe('');
    expect(within(d).queryByTestId('take-money-max')).toBeNull();
  });

  it('60,000 shows “20,000 profit + 40,000 capital” before Take, and sends one take of 60,000', async () => {
    wrap();
    await openTake();
    typeInto(amountInput(), '60000');
    expect(text(within(dialog()).getByTestId('take-split'))).toBe('This take is20,000.00 EGP profit + 40,000.00 EGP capital');
    submitTake();
    await waitFor(() => expect(state.posts).toHaveLength(1));
    expect(state.posts[0]).toEqual({
      url: '/cycles/c-1/take',
      body: { userId: 'u-a', amountEgp: 60000, takenOn: businessToday(), note: undefined },
    });
  });

  it('within his profit the split is profit only; a piastre over it starts on capital', async () => {
    wrap();
    await openTake();
    typeInto(amountInput(), '20000');
    expect(text(within(dialog()).getByTestId('take-split'))).toBe('This take is20,000.00 EGP profit');
    typeInto(amountInput(), '20000.01');
    expect(text(within(dialog()).getByTestId('take-split'))).toBe('This take is20,000.00 EGP profit + 0.01 EGP capital');
  });

  it('an investor’s take is capital only', async () => {
    state.userId = 'u-m';
    wrap();
    await openTake();
    expect(text(within(dialog()).getByTestId('take-rooms'))).toBe('Profit 0.00 EGP · Capital 14,000.00 EGP');
    typeInto(amountInput(), '5000');
    expect(text(within(dialog()).getByTestId('take-split'))).toBe('This take is5,000.00 EGP capital');
  });

  it('"Take all available" fills his whole total; an amount he typed afterwards is his, not overwritten', async () => {
    wrap();
    await openTake();
    fireEvent.click(within(dialog()).getByTestId('take-all'));
    expect(amountInput().value.replace(/,/g, '')).toBe('60000');
    typeInto(amountInput(), '123');
    // A re-render (the card read again) must not put the total back.
    await waitFor(() => expect(state.reads).toBeGreaterThanOrEqual(1));
    expect(amountInput().value).toBe('123');
    submitTake();
    await waitFor(() => expect(state.posts).toHaveLength(1));
    expect((state.posts[0].body as { amountEgp: number }).amountEgp).toBe(123);
  });

  it('a piastre over his total is refused before asking, with no split shown; zero too', async () => {
    wrap();
    await openTake();
    typeInto(amountInput(), '60000.01');
    expect(within(dialog()).queryByTestId('take-split')).toBeNull();
    submitTake();
    expect(text(await screen.findByTestId('take-money-problem'))).toBe('Abdallah can take at most 60,000.00 EGP now.');
    typeInto(amountInput(), '0');
    submitTake();
    expect(text(await screen.findByTestId('take-money-problem'))).toBe(en.takeMoney.notPositive);
    expect(state.posts).toHaveLength(0);
  });

  it('nothing left to take: says so, and offers no “take all”', async () => {
    state.view = fixture({
      people: [{ ...fixture().people[1], capital: { ...fixture().people[1].capital, availableEgp: '0.00' }, availableEgp: '0.00' }],
    });
    state.userId = 'u-m';
    wrap();
    await openTake();
    expect(within(dialog()).queryByTestId('take-all')).toBeNull();
    typeInto(amountInput(), '1');
    submitTake();
    expect(text(await screen.findByTestId('take-money-problem'))).toBe('Setta has nothing to take now.');
  });

  it('the server is the authority: its refusal is shown in the reader’s language, the form stays open, the card is read again', async () => {
    state.refusal = {
      code: 'TAKE_OVER_AVAILABLE',
      message: 'x',
      params: { partner: 'Abdallah', cycle: 'CYC-2026-0001', available: '3,000.00', profit: '1,000.00', capital: '2,000.00' },
    };
    wrap('ar');
    await openTake();
    typeInto(amountInput(), '5000');
    submitTake(ar.takeMoney.take);
    const problem = await screen.findByTestId('take-money-problem');
    expect(problem.textContent).toContain('3,000.00');
    expect(problem.textContent).toContain('CYC-2026-0001');
    expect(problem.textContent).not.toMatch(/can take at most/);
    expect(dialog()).toBeTruthy();
    await waitFor(() => expect(state.reads).toBeGreaterThanOrEqual(2));
  });

  it('pressed twice while saving sends one request', async () => {
    state.hang = true;
    wrap();
    await openTake();
    typeInto(amountInput(), '1000');
    submitTake();
    submitTake();
    await waitFor(() => expect(state.posts).toHaveLength(1));
  });

  it('after it is saved the card is read again; opened a second time the form starts clean', async () => {
    wrap();
    await openTake();
    typeInto(amountInput(), '1000');
    submitTake();
    await waitFor(() => expect(screen.queryByTestId('take-money-dialog')).toBeNull());
    await waitFor(() => expect(state.reads).toBeGreaterThanOrEqual(2));
    await openTake();
    expect(amountInput().value).toBe('');
    expect(screen.queryByTestId('take-money-problem')).toBeNull();
    expect(screen.queryByTestId('take-split')).toBeNull();
  });
});

describe('Undo', () => {
  async function openUndo(id = 't-1') {
    wrap();
    await screen.findByTestId('take-money-card');
    fireEvent.click(within(takenRow(id)).getByTestId('undo-taken'));
    return screen.findByTestId('undo-taken-dialog');
  }
  const submit = (d: HTMLElement) => within(d).getByRole('button', { name: en.takeMoney.undo });

  it('worded for what it undoes: profit here', async () => {
    const d = await openUndo();
    expect(d.textContent).toContain(en.takeMoney.undoTitlePROFIT);
  });

  it('needs a reason: none, or only spaces, cannot be sent', async () => {
    const d = await openUndo();
    expect(submit(d)).toHaveProperty('disabled', true);
    fireEvent.change(d.querySelector('input[name="reason"]')!, { target: { value: '   ' } });
    expect(submit(d)).toHaveProperty('disabled', true);
    fireEvent.submit(d.querySelector('form')!);
    await new Promise((r) => setTimeout(r, 50));
    expect(state.posts).toHaveLength(0);
  });

  it('sends the reason, trimmed, for that one part only', async () => {
    const d = await openUndo();
    fireEvent.change(d.querySelector('input[name="reason"]')!, { target: { value: '  entered on the wrong cycle ' } });
    fireEvent.click(submit(d));
    await waitFor(() => expect(state.posts).toHaveLength(1));
    expect(state.posts[0]).toEqual({ url: '/profit-draws/t-1/reverse', body: { reason: 'entered on the wrong cycle' } });
  });

  it('pressed twice while undoing sends one request', async () => {
    state.hang = true;
    const d = await openUndo();
    fireEvent.change(d.querySelector('input[name="reason"]')!, { target: { value: 'wrong' } });
    fireEvent.click(submit(d));
    fireEvent.click(submit(d));
    await waitFor(() => expect(state.posts).toHaveLength(1));
  });

  it('the server’s refusal (settled meanwhile) is said, not a generic failure', async () => {
    state.refusal = { code: 'PROFIT_DRAW_SETTLED', message: 'This was taken off a paid settlement.' };
    const d = await openUndo();
    fireEvent.change(d.querySelector('input[name="reason"]')!, { target: { value: 'wrong' } });
    fireEvent.click(submit(d));
    expect(text(await screen.findByTestId('undo-taken-problem'))).toBe(en.errors.PROFIT_DRAW_SETTLED);
  });
});

describe('the preview cuts as the server does (rule 11)', () => {
  const D = (v: number) => new Prisma.Decimal(v).div(100);
  const cases: Array<[number, number, number]> = [
    [6_000_000, 2_000_000, 5_000_000],
    [1_500_000, 2_000_000, 5_000_000],
    [2_000_000, 2_000_000, 5_000_000],
    [2_000_001, 2_000_000, 5_000_000],
    [7_000_000, 2_000_000, 5_000_000],
    [7_000_001, 2_000_000, 5_000_000],
    [10_000, 0, 50_000],
    [50_000, -30_000, 50_000],
    [50_001, -30_000, 50_000],
    [0, 100, 100],
    [-1, 100, 100],
    [30, 10, 20],
  ];
  it.each(cases)('%i of %i profit + %i capital', (amount, profit, capital) => {
    const mine = splitTake(amount, profit, capital);
    const theirs = server.splitTake(D(amount), D(profit), D(capital));
    expect(mine && [mine.profit, mine.capital]).toEqual(
      theirs && [theirs.profit.mul(100).toNumber(), theirs.capital.mul(100).toNumber()],
    );
  });
});

describe('every new word, in both languages', () => {
  type Tree = { [k: string]: string | Tree };
  const at = (tree: Tree, path: string) => path.split('.').reduce<Tree | string | undefined>((n, k) => (n as Tree)?.[k], tree);
  const params = (s: string) => [...s.matchAll(/\{(\w+)[,}]|<(\w+)>/g)].map((m) => m[1] ?? m[2]).sort();

  const KEYS = [
    ...Object.keys(en.takeMoney).map((k) => `takeMoney.${k}`),
    ...Object.keys(en.codes.profitDrawLock).map((k) => `codes.profitDrawLock.${k}`),
    ...[
      'TAKE_OVER_AVAILABLE', 'CAPITAL_BACK_NOT_ON_CYCLE', 'CAPITAL_BACK_OVER_AVAILABLE',
      'PROFIT_DRAW_NOT_ON_CYCLE', 'PROFIT_DRAW_OVER_AVAILABLE', 'PROFIT_DRAW_CYCLE_LOCKED', 'PROFIT_DRAW_REASON_REQUIRED',
      'PROFIT_DRAW_ALREADY_REVERSED', 'PROFIT_DRAW_SETTLED', 'PROFIT_DRAW_AMOUNT_NOT_POSITIVE', 'PROFIT_DRAW_AMOUNT_PRECISION',
    ].map((k) => `errors.${k}`),
    'codes.dateField.MONEY_TAKEN',
  ];

  it('each is in English and Arabic, not empty, with the same placeholders', () => {
    expect(KEYS.length).toBeGreaterThan(60);
    for (const key of KEYS) {
      const e = at(en as unknown as Tree, key);
      const a = at(ar as unknown as Tree, key);
      expect(typeof e, key).toBe('string');
      expect(typeof a, key).toBe('string');
      expect((e as string).trim(), key).not.toBe('');
      expect((a as string).trim(), key).not.toBe('');
      expect(params(a as string), key).toEqual(params(e as string));
    }
  });

  it('the combined refusal carries the params the API sends', () => {
    expect(params(en.errors.TAKE_OVER_AVAILABLE)).toEqual(['available', 'capital', 'cycle', 'partner', 'profit']);
  });
});
