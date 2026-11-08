import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/i18n/locales/en.json';
import ar from '@/i18n/locales/ar.json';
import { ToastProvider } from '@/components/ui/toast';
import { businessToday } from '@/lib/dates';
import { CapitalBackCard, type CapitalBackView } from './capital-back-card';

/**
 * Capital taken back before settlement (BUSINESS_LOGIC §8, owner 2026-11-08).
 * The server owns every figure and rule; these pin what the card says, that
 * investors are on it beside partners, that the form says the limit before
 * asking, that the server's refusal reaches the reader, and that a locked
 * cycle offers nothing to press.
 */

type Refusal = { code: string; message: string; params?: Record<string, unknown> };

const state = vi.hoisted(() => ({
  view: null as unknown as CapitalBackView,
  userId: 'u-a',
  posts: [] as Array<{ url: string; body: unknown }>,
  refusal: null as null | Refusal,
}));

vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ user: { id: state.userId, email: 'abdallah@motoparts.com', role: 'CORE_PARTNER' }, isLoading: false }),
}));
vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string) =>
      Promise.resolve({ data: { data: url === '/cycles/c-1/capital-back' ? state.view : [] } }),
    post: (url: string, body: unknown) => {
      state.posts.push({ url, body });
      if (state.refusal) {
        const error = state.refusal;
        state.refusal = null;
        return Promise.reject(
          Object.assign(new Error(error.message), { isAxiosError: true, response: { status: 400, data: { error } } }),
        );
      }
      return Promise.resolve({ data: { data: { id: 'x-new' } } });
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

const person = (id: string, name: string, type: string, put: string, rec: string, taken: string, avail: string) => ({
  userId: `u-${id}`,
  participantType: type,
  name,
  contributionEgp: put,
  recoveredEgp: rec,
  takenEgp: taken,
  availableEgp: avail,
});

const taken = (id: string, who: string, name: string, amount: string, extra: Partial<CapitalBackView['taken'][number]> = {}) => ({
  id,
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

/** 70% of the cost recovered: Abdallah 38,500 of 55,000, Setta (investor) 14,000 of 20,000. */
function fixture(over: Partial<CapitalBackView> = {}): CapitalBackView {
  return {
    cycleId: 'c-1',
    cycleCode: 'CYC-2026-0001',
    locked: null,
    toFundEgp: '200000.00',
    recoveredEgp: '140000.00',
    recoveredPct: '70.00',
    people: [
      person('a', 'Abdallah', 'CORE_PARTNER', '55000.00', '38500.00', '10000.00', '28500.00'),
      person('m', 'Setta', 'TEMP_INVESTOR', '20000.00', '14000.00', '0.00', '14000.00'),
    ],
    taken: [
      taken('t-1', 'a', 'Abdallah', '10000.00'),
      taken('t-2', 'm', 'Setta', '500.00', { reversedAt: '2026-11-02T10:00:00Z', reversalReason: 'typed twice' }),
      taken('t-3', 'a', 'Abdallah', '2000.00', { settled: true }),
    ],
    ...over,
  };
}

beforeEach(() => {
  state.view = fixture();
  state.userId = 'u-a';
  state.posts = [];
  state.refusal = null;
});
afterEach(cleanup);

function wrap(locale: 'en' | 'ar' = 'en') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === 'ar' ? ar : en} timeZone="Africa/Cairo">
      <QueryClientProvider client={client}>
        <ToastProvider>
          <CapitalBackCard cycleId="c-1" />
        </ToastProvider>
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/ /g, ' ');
const rowOf = (id: string) =>
  screen.getAllByTestId('capital-back-person').find((r) => r.getAttribute('data-person') === `u-${id}`)!;
const takenRow = (id: string) => screen.getAllByTestId('capital-taken').find((r) => r.getAttribute('data-taken') === id)!;
const amountInput = () => screen.getByTestId('take-capital-dialog').querySelector<HTMLInputElement>('#take-capital-amount')!;
function typeInto(input: HTMLInputElement, value: string) {
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
}
const submitTake = () =>
  fireEvent.click(within(screen.getByTestId('take-capital-dialog')).getByRole('button', { name: en.capitalBack.take }));
async function openTake() {
  fireEvent.click(await screen.findByTestId('take-capital'));
  return screen.findByTestId('take-capital-dialog');
}

describe('the card reads the server’s figures', () => {
  it('the share recovered, and per person put in, recovered, taken back and can take now — the investor too', async () => {
    wrap();
    const card = await screen.findByTestId('capital-back-card');
    expect(text(within(card).getByTestId('capital-back-recovered'))).toBe('70%');
    expect(text(card)).toContain('140,000.00 EGP of the 200,000.00 EGP it cost to fund');
    const a = rowOf('a');
    expect(text(within(a).getByTestId('capital-put-in'))).toBe('55,000.00 EGP');
    expect(text(within(a).getByTestId('capital-recovered'))).toBe('38,500.00 EGP');
    expect(text(within(a).getByTestId('capital-taken'))).toBe('10,000.00 EGP');
    expect(text(within(a).getByTestId('capital-available'))).toBe('28,500.00 EGP');
    expect(a.textContent).not.toContain(en.capitalBack.investor);
    const m = rowOf('m');
    expect(m.textContent).toContain(en.capitalBack.investor);
    expect(text(within(m).getByTestId('capital-available'))).toBe('14,000.00 EGP');
  });

  it('history: undone struck through with its reason, settled marked, Undo only on what stands', async () => {
    wrap();
    await screen.findByTestId('capital-back-card');
    expect(text(within(takenRow('t-2')).getByTestId('capital-reversed'))).toBe('Undone: typed twice');
    expect(within(takenRow('t-2')).queryByTestId('undo-capital')).toBeNull();
    expect(text(within(takenRow('t-3')).getByTestId('capital-settled'))).toBe(en.capitalBack.settled);
    expect(within(takenRow('t-3')).queryByTestId('undo-capital')).toBeNull();
    expect(within(takenRow('t-1')).getByTestId('undo-capital')).toBeTruthy();
    for (const b of within(screen.getByTestId('capital-back-card')).getAllByRole('button')) {
      expect(b.getAttribute('type')).toBe('button');
    }
  });

  it('Arabic: no English left, amounts left-to-right', async () => {
    wrap('ar');
    const card = await screen.findByTestId('capital-back-card');
    expect(card.textContent).toContain(ar.capitalBack.title);
    expect(card.textContent).toContain(ar.capitalBack.investor);
    for (const word of [en.capitalBack.title, en.capitalBack.colAvailable, en.capitalBack.take, 'Investor', 'Undone']) {
      expect(card.textContent).not.toContain(word);
    }
    for (const m of card.querySelectorAll('[data-slot="money"]')) expect(m.getAttribute('dir')).toBe('ltr');
  });
});

describe('locked', () => {
  it('approved settlement: no Take, no Undo, and why', async () => {
    state.view = fixture({ locked: 'SETTLEMENT_APPROVED' });
    wrap();
    const card = await screen.findByTestId('capital-back-card');
    expect(within(card).queryByTestId('take-capital')).toBeNull();
    expect(within(card).queryAllByTestId('undo-capital')).toHaveLength(0);
    expect(text(within(card).getByTestId('capital-back-locked'))).toBe(
      en.capitalBack.locked.replace('{reason}', en.codes.profitDrawLock.SETTLEMENT_APPROVED),
    );
  });

  it('a read that fails says so with a retry', async () => {
    state.view = { data: [] } as unknown as CapitalBackView;
    wrap();
    expect(await screen.findByTestId('capital-back-error')).toBeTruthy();
  });
});

describe('Take capital back', () => {
  it('defaults to the signed-in partner; "Take all available" sends his whole room, dated today', async () => {
    wrap();
    const dialog = await openTake();
    expect(dialog.querySelector<HTMLInputElement>('input[name="person"]')!.value).toBe('u-a');
    expect(text(within(dialog).getByTestId('take-capital-max'))).toBe('Max 28,500.00 EGP');
    fireEvent.click(within(dialog).getByTestId('take-all-capital'));
    submitTake();
    await waitFor(() => expect(state.posts).toHaveLength(1));
    expect(state.posts[0]).toEqual({
      url: '/cycles/c-1/capital-back',
      body: { userId: 'u-a', amountEgp: 28500, takenOn: businessToday(), note: undefined },
    });
  });

  it('a piastre over his room is refused before asking; zero too', async () => {
    wrap();
    await openTake();
    typeInto(amountInput(), '28500.01');
    submitTake();
    expect(text(await screen.findByTestId('take-capital-problem'))).toBe('Abdallah can take back at most 28,500.00 EGP now.');
    typeInto(amountInput(), '0');
    submitTake();
    expect(text(await screen.findByTestId('take-capital-problem'))).toBe(en.capitalBack.notPositive);
    expect(state.posts).toHaveLength(0);
  });

  it('the server’s refusal is shown in the reader’s language and the form stays open', async () => {
    state.refusal = {
      code: 'CAPITAL_BACK_OVER_AVAILABLE',
      message: 'x',
      params: { partner: 'Abdallah', cycle: 'CYC-2026-0001', available: '3,000.00', pct: '70.00', recovered: '38,500.00', contribution: '55,000.00', taken: '35,500.00' },
    };
    wrap('ar');
    const dialog = await openTake();
    typeInto(amountInput(), '5000');
    fireEvent.click(within(dialog).getByRole('button', { name: ar.capitalBack.take }));
    const problem = await screen.findByTestId('take-capital-problem');
    expect(problem.textContent).toContain('3,000.00');
    expect(problem.textContent).not.toContain('can take back');
    expect(screen.getByTestId('take-capital-dialog')).toBeTruthy();
  });

  it('Undo sends the reason to the one undo endpoint, worded for capital', async () => {
    wrap();
    await screen.findByTestId('capital-back-card');
    fireEvent.click(within(takenRow('t-1')).getByTestId('undo-capital'));
    const dialog = await screen.findByTestId('undo-draw-dialog');
    expect(dialog.textContent).toContain(en.capitalBack.undoTitle);
    fireEvent.change(dialog.querySelector<HTMLInputElement>('input[name="reason"]')!, { target: { value: 'typed twice' } });
    fireEvent.click(within(dialog).getByRole('button', { name: en.capitalBack.undo }));
    await waitFor(() => expect(state.posts).toHaveLength(1));
    expect(state.posts[0]).toEqual({ url: '/profit-draws/t-1/reverse', body: { reason: 'typed twice' } });
  });
});
