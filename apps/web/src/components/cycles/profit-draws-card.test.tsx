import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/i18n/locales/en.json';
import ar from '@/i18n/locales/ar.json';
import { ToastProvider } from '@/components/ui/toast';
import { businessToday } from '@/lib/dates';
import { ProfitDrawsCard, type ProfitDrawsView } from './profit-draws-card';

/**
 * Profit a core partner takes before settlement (BUSINESS_LOGIC §8, owner
 * 2026-11-08). The server owns every figure and every rule; these pin what the
 * card says about them, that the form says the limit it was shown before
 * asking, that the server's refusal still reaches the reader when the form
 * let it through, and that a locked cycle offers nothing to press.
 */

type Refusal = { code: string; message: string; params?: Record<string, unknown> };

const state = vi.hoisted(() => ({
  view: null as unknown as ProfitDrawsView,
  userId: 'u-a',
  reads: 0,
  posts: [] as Array<{ url: string; body: unknown }>,
  /** A coded refusal the next POST answers with. */
  refusal: null as null | Refusal,
  /** POSTs never answer: a save in flight. */
  hang: false,
}));

const refused = (error: Refusal) =>
  Promise.reject(Object.assign(new Error(error.message), { isAxiosError: true, response: { status: 400, data: { error } } }));

vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ user: { id: state.userId, email: 'abdallah@motoparts.com', role: 'CORE_PARTNER' }, isLoading: false }),
}));
vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string) => {
      if (url === '/cycles/c-1/profit-draws') {
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
        return refused(error);
      }
      return Promise.resolve({ data: { data: { id: 'd-new' } } });
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

const partner = (id: string, name: string, share: string, drawn: string, owed: string, available: string) => ({
  partnerUserId: `u-${id}`,
  name,
  sharePct: '33.3333',
  shareOfCollectedEgp: share,
  drawnEgp: drawn,
  owedEgp: owed,
  availableEgp: available,
});

const draw = (id: string, who: string, name: string, amount: string, extra: Partial<ProfitDrawsView['draws'][number]> = {}) => ({
  id,
  partnerUserId: `u-${who}`,
  name,
  amountEgp: amount,
  drawnOn: '2026-11-01',
  note: null,
  createdAt: '2026-11-01T10:00:00Z',
  reversedAt: null,
  reversalReason: null,
  settled: false,
  ...extra,
});

/** 90,000 profit, 30,000 still with customers: 60,000 collected, 20,000 each. */
function fixture(over: Partial<ProfitDrawsView> = {}): ProfitDrawsView {
  return {
    cycleId: 'c-1',
    cycleCode: 'CYC-2026-0001',
    locked: null,
    profitEgp: '90000.00',
    uncollectedEgp: '30000.00',
    salesEgp: '90000.00',
    salesPaidEgp: '60000.00',
    sharePaidPct: '66.67',
    collectedProfitEgp: '60000.00',
    problem: null,
    partners: [
      partner('a', 'Abdallah', '20000.00', '15000.00', '0.00', '5000.00'),
      partner('s', 'Shady', '20000.00', '0.00', '2500.00', '17500.00'),
      partner('f', 'Fares', '20000.00', '20000.00', '0.00', '0.00'),
    ],
    draws: [
      draw('d-1', 'a', 'Abdallah', '15000.00'),
      draw('d-2', 'f', 'Fares', '20000.00'),
      draw('d-3', 's', 'Shady', '4000.00', { reversedAt: '2026-11-02T10:00:00Z', reversalReason: 'typed twice' }),
      draw('d-4', 'a', 'Abdallah', '3000.00', { settled: true }),
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
          <ProfitDrawsCard cycleId="c-1" />
        </ToastProvider>
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/ /g, ' ');
const rowOf = (id: string) =>
  screen.getAllByTestId('profit-draw-partner').find((r) => r.getAttribute('data-partner') === `u-${id}`)!;
const drawRow = (id: string) => screen.getAllByTestId('profit-draw').find((r) => r.getAttribute('data-draw') === id)!;
const amountInput = () => screen.getByTestId('take-profit-dialog').querySelector<HTMLInputElement>('#take-profit-amount')!;
function typeInto(input: HTMLInputElement, value: string) {
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
}
const submitTake = () =>
  fireEvent.click(within(screen.getByTestId('take-profit-dialog')).getByRole('button', { name: en.profitDraws.take }));

async function openTake() {
  fireEvent.click(await screen.findByTestId('take-profit'));
  return screen.findByTestId('take-profit-dialog');
}

describe('the card reads the server’s figures', () => {
  it('collected profit with its one-line explanation, and per partner his share, taken, owes and can take now', async () => {
    wrap();
    const card = await screen.findByTestId('profit-draws-card');
    expect(text(within(card).getByTestId('profit-draws-collected'))).toBe('60,000.00 EGP');
    expect(card.textContent).toContain(en.profitDraws.collectedHint);
    // The dashboard's proportional reading: the share of its sales paid (owner 2026-11-08).
    expect(card.textContent).toContain('66.67% of its sales paid');

    const a = rowOf('a');
    expect(text(within(a).getByTestId('draw-share'))).toBe('20,000.00 EGP');
    expect(text(within(a).getByTestId('draw-taken'))).toBe('15,000.00 EGP');
    expect(text(within(a).getByTestId('draw-available'))).toBe('5,000.00 EGP');
    // Owes only when he owes something.
    expect(within(a).queryByTestId('draw-owes')).toBeNull();
    expect(text(within(rowOf('s')).getByTestId('draw-owes'))).toBe('2,500.00 EGP');
    expect(text(within(rowOf('f')).getByTestId('draw-available'))).toBe('0.00 EGP');
  });

  it('the draws: a reversed one struck through with its reason, a settled one marked, Undo only on the standing ones', async () => {
    wrap();
    await screen.findByTestId('profit-draws-card');
    const reversed = drawRow('d-3');
    expect(reversed.querySelector('.line-through')).not.toBeNull();
    expect(text(within(reversed).getByTestId('draw-reversed'))).toBe('Undone: typed twice');
    expect(within(reversed).queryByTestId('undo-draw')).toBeNull();

    const settled = drawRow('d-4');
    expect(text(within(settled).getByTestId('draw-settled'))).toBe(en.profitDraws.settled);
    expect(within(settled).queryByTestId('undo-draw')).toBeNull();

    expect(within(drawRow('d-1')).getByTestId('undo-draw')).toBeTruthy();
    expect(within(drawRow('d-2')).getByTestId('undo-draw')).toBeTruthy();
    // Every button says it is a button: the page has forms (CLAUDE.md §13).
    for (const b of within(screen.getByTestId('profit-draws-card')).getAllByRole('button')) {
      expect(b.getAttribute('type')).toBe('button');
    }
  });

  it('Arabic: the card in Arabic, amounts left-to-right, no English left', async () => {
    wrap('ar');
    const card = await screen.findByTestId('profit-draws-card');
    expect(card.textContent).toContain(ar.profitDraws.title);
    expect(card.textContent).toContain(ar.profitDraws.colAvailable);
    for (const word of [en.profitDraws.title, en.profitDraws.colAvailable, en.profitDraws.take, 'Undone']) {
      expect(card.textContent).not.toContain(word);
    }
    for (const m of card.querySelectorAll('[data-slot="money"]')) expect(m.getAttribute('dir')).toBe('ltr');
  });
});

describe('locked or not yet possible', () => {
  it('approved settlement: no Take, no Undo, and the reason why', async () => {
    state.view = fixture({ locked: 'SETTLEMENT_APPROVED' });
    wrap();
    const card = await screen.findByTestId('profit-draws-card');
    expect(within(card).queryByTestId('take-profit')).toBeNull();
    expect(within(card).queryAllByTestId('undo-draw')).toHaveLength(0);
    expect(text(within(card).getByTestId('profit-draws-locked'))).toBe(
      en.profitDraws.locked.replace('{reason}', en.codes.profitDrawLock.SETTLEMENT_APPROVED),
    );
  });

  it('a closed cycle says so in Arabic, never the raw status', async () => {
    state.view = fixture({ locked: 'CLOSED' });
    wrap('ar');
    const locked = await screen.findByTestId('profit-draws-locked');
    expect(locked.textContent).toContain(ar.codes.profitDrawLock.CLOSED);
    expect(locked.textContent).not.toContain('CLOSED');
    expect(screen.queryByTestId('take-profit')).toBeNull();
  });

  it('no split yet (funding not entered): says nothing can be taken, and offers no Take', async () => {
    state.view = fixture({ problem: 'CYCLE_NOT_FUNDED', profitEgp: null, collectedProfitEgp: '0.00' });
    wrap();
    expect(text(await screen.findByTestId('profit-draws-problem'))).toBe(en.profitDraws.problem);
    expect(screen.queryByTestId('take-profit')).toBeNull();
  });

  it('a read that fails says so with a retry, not a blank card', async () => {
    state.view = { data: [] } as unknown as ProfitDrawsView;
    wrap();
    expect(await screen.findByTestId('profit-draws-error')).toBeTruthy();
  });
});

describe('Take profit', () => {
  it('defaults to the signed-in partner when he is on the cycle, with his max', async () => {
    wrap();
    const dialog = await openTake();
    expect(dialog.querySelector<HTMLInputElement>('input[name="partner"]')!.value).toBe('u-a');
    expect(text(within(dialog).getByTestId('take-profit-max'))).toBe('Max 5,000.00 EGP');
  });

  it('a partner not on this cycle gets no default — he picks', async () => {
    state.userId = 'u-other';
    wrap();
    const dialog = await openTake();
    expect(dialog.querySelector<HTMLInputElement>('input[name="partner"]')!.value).toBe('');
    expect(within(dialog).queryByTestId('take-profit-max')).toBeNull();
  });

  it('"Take all available" fills his whole room and sends it, dated today', async () => {
    wrap();
    const dialog = await openTake();
    fireEvent.click(within(dialog).getByTestId('take-all'));
    expect(amountInput().value).toBe('5,000');
    submitTake();
    await waitFor(() => expect(state.posts).toHaveLength(1));
    expect(state.posts[0]).toEqual({
      url: '/cycles/c-1/profit-draws',
      body: { partnerUserId: 'u-a', amountEgp: 5000, drawnOn: businessToday(), note: undefined },
    });
  });

  it('more than he can take is refused before asking — and a piastre over counts', async () => {
    wrap();
    await openTake();
    typeInto(amountInput(), '5000.01');
    submitTake();
    expect(text(await screen.findByTestId('take-profit-problem'))).toBe('Abdallah can take at most 5,000.00 EGP now.');
    expect(state.posts).toHaveLength(0);
  });

  it('zero is refused before asking', async () => {
    wrap();
    await openTake();
    typeInto(amountInput(), '0');
    submitTake();
    expect(text(await screen.findByTestId('take-profit-problem'))).toBe(en.profitDraws.notPositive);
    expect(state.posts).toHaveLength(0);
  });

  it('the server is the authority: its refusal is shown in the reader’s language and the form stays open', async () => {
    state.refusal = {
      code: 'PROFIT_DRAW_OVER_AVAILABLE',
      message: 'Abdallah can take at most 3,000.00 EGP from CYC-2026-0001 now.',
      params: { partner: 'Abdallah', cycle: 'CYC-2026-0001', available: '3,000.00', share: '20,000.00', drawn: '17,000.00', owed: '0.00' },
    };
    wrap('ar');
    await openTake();
    typeInto(amountInput(), '4000');
    fireEvent.click(within(screen.getByTestId('take-profit-dialog')).getByRole('button', { name: ar.profitDraws.take }));
    const problem = await screen.findByTestId('take-profit-problem');
    expect(problem.textContent).toContain('3,000.00');
    expect(problem.textContent).toContain('CYC-2026-0001');
    expect(problem.textContent).not.toMatch(/can take at most/);
    expect(screen.getByTestId('take-profit-dialog')).toBeTruthy();
    // It read the card again: the figures it was shown were out of date.
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
    expect(within(screen.getByTestId('take-profit-dialog')).getByRole('button', { name: en.profitDraws.take })).toHaveProperty('disabled', true);
  });

  it('after it is saved the card is read again; opened a second time the form starts clean', async () => {
    wrap();
    await openTake();
    typeInto(amountInput(), '1000');
    submitTake();
    await waitFor(() => expect(screen.queryByTestId('take-profit-dialog')).toBeNull());
    await waitFor(() => expect(state.reads).toBeGreaterThanOrEqual(2));
    await openTake();
    expect(amountInput().value).toBe('');
    expect(screen.queryByTestId('take-profit-problem')).toBeNull();
  });
});

describe('Undo', () => {
  async function openUndo() {
    wrap();
    await screen.findByTestId('profit-draws-card');
    fireEvent.click(within(drawRow('d-1')).getByTestId('undo-draw'));
    return screen.findByTestId('undo-draw-dialog');
  }
  const submit = (dialog: HTMLElement) => within(dialog).getByRole('button', { name: en.profitDraws.undo });

  it('needs a reason: none, or only spaces, cannot be sent', async () => {
    const dialog = await openUndo();
    expect(submit(dialog)).toHaveProperty('disabled', true);
    fireEvent.change(dialog.querySelector('input[name="reason"]')!, { target: { value: '   ' } });
    expect(submit(dialog)).toHaveProperty('disabled', true);
    fireEvent.submit(dialog.querySelector('form')!);
    // A request would leave on the next tick: give it the chance.
    await new Promise((r) => setTimeout(r, 50));
    expect(state.posts).toHaveLength(0);
  });

  it('sends the reason, trimmed, for that draw', async () => {
    const dialog = await openUndo();
    fireEvent.change(dialog.querySelector('input[name="reason"]')!, { target: { value: '  entered on the wrong cycle ' } });
    fireEvent.click(submit(dialog));
    await waitFor(() => expect(state.posts).toHaveLength(1));
    expect(state.posts[0]).toEqual({ url: '/profit-draws/d-1/reverse', body: { reason: 'entered on the wrong cycle' } });
  });

  it('pressed twice while undoing sends one request', async () => {
    state.hang = true;
    const dialog = await openUndo();
    fireEvent.change(dialog.querySelector('input[name="reason"]')!, { target: { value: 'wrong' } });
    fireEvent.click(submit(dialog));
    fireEvent.click(submit(dialog));
    await waitFor(() => expect(state.posts).toHaveLength(1));
  });

  it('the server’s refusal (settled meanwhile) is said, not a generic failure', async () => {
    state.refusal = { code: 'PROFIT_DRAW_SETTLED', message: 'This was taken off a paid settlement.' };
    const dialog = await openUndo();
    fireEvent.change(dialog.querySelector('input[name="reason"]')!, { target: { value: 'wrong' } });
    fireEvent.click(submit(dialog));
    expect(text(await screen.findByTestId('undo-draw-problem'))).toBe(en.errors.PROFIT_DRAW_SETTLED);
  });
});

describe('every new word, in both languages', () => {
  type Tree = { [k: string]: string | Tree };
  const at = (tree: Tree, path: string) => path.split('.').reduce<Tree | string | undefined>((n, k) => (n as Tree)?.[k], tree);
  const params = (s: string) => [...s.matchAll(/\{(\w+)[,}]|<(\w+)>/g)].map((m) => m[1] ?? m[2]).sort();

  const KEYS = [
    ...Object.keys(en.profitDraws).map((k) => `profitDraws.${k}`),
    ...Object.keys(en.codes.profitDrawLock).map((k) => `codes.profitDrawLock.${k}`),
    ...[
      'PROFIT_DRAW_NOT_ON_CYCLE', 'PROFIT_DRAW_OVER_AVAILABLE', 'PROFIT_DRAW_CYCLE_LOCKED', 'PROFIT_DRAW_REASON_REQUIRED',
      'PROFIT_DRAW_CARRIED_NOT_REVERSIBLE', 'PROFIT_DRAW_ALREADY_REVERSED', 'PROFIT_DRAW_SETTLED',
      'PROFIT_DRAW_AMOUNT_NOT_POSITIVE', 'PROFIT_DRAW_AMOUNT_PRECISION', 'SETTLEMENT_STALE_DRAWS', 'SETTLEMENT_OWED_TAKEN_LATER',
    ].map((k) => `errors.${k}`),
    'errors.entity.profitDraw',
    'codes.referenceType.PROFIT_DRAW',
    'codes.auditAction.PROFIT_DRAW',
    'codes.auditAction.PROFIT_DRAW_REVERSE',
    'codes.entityType.ProfitDraw',
    'codes.dateField.PROFIT_DRAWN',
    'codes.ledgerCategory.profit_draw',
    'ledger.profitDraw',
    'ledger.profitDrawReversal',
    'settlementsPage.profitTaken',
    'settlementsPage.profitTakenLine',
    'settlementsPage.owedLine',
    'settlementsPage.owesNote',
  ];

  it('each is in English and Arabic, not empty, with the same placeholders', () => {
    expect(KEYS.length).toBeGreaterThan(50);
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

  it('the refusals carry the params the API sends', () => {
    expect(params(en.errors.PROFIT_DRAW_OVER_AVAILABLE)).toEqual(['available', 'cycle', 'drawn', 'owed', 'partner', 'share']);
    expect(params(en.errors.PROFIT_DRAW_NOT_ON_CYCLE)).toEqual(['cycle', 'partner']);
    expect(params(en.errors.PROFIT_DRAW_CYCLE_LOCKED)).toEqual(['cycle', 'status']);
    expect(params(en.errors.SETTLEMENT_OWED_TAKEN_LATER)).toEqual(['cycle']);
  });
});
