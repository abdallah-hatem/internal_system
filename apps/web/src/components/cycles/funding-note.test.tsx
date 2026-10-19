import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/i18n/locales/en.json';
import ar from '@/i18n/locales/ar.json';
import { ToastProvider } from '@/components/ui/toast';
import CycleDetailsPage from '@/app/[locale]/cycles/[cycleId]/details/page';
import { remainingIn } from '@/components/lenders/paid-by-friend';

/**
 * "Funding not entered yet" on the cycle page, and funding locked once the
 * settlement is approved (BUSINESS_LOGIC §8, owner 2026-10-18).
 *
 * The wizard ends at the shipping step now and lands here, so this note is
 * where the funding is asked for. It shows while settling would be refused
 * for want of a basis — the server's `profitBasis` reading, the settlement's
 * own — and goes once the partners put money in. Since 2026-10-19 (§18) a
 * friend paying it all is not a basis: the note names him and asks the
 * partners to split repaying him, in any shares ("maybe 30,30,40").
 *
 * The fake API below plays the server: the costing's `profitBasis` is worked
 * out from what has been written, as `profitBasisOf` does, so a save shows
 * the note re-evaluating the way it would against the real one.
 */

/** What the page writes: a contribution, or a friend's payment. */
type WriteBody = {
  contributionAmount?: number;
  amount: number;
  currency?: string;
  fxRateToEgp?: number;
  lenderId?: string;
};

type Participant = {
  id: string;
  participantType: 'CORE_PARTNER' | 'TEMP_INVESTOR';
  contributionAmount: string;
  customProfitPct: string | null;
  partner: { email: string; partner: { displayName: string } };
};

const state = vi.hoisted(() => ({
  status: 'PURCHASING',
  fundingLock: null as string | null,
  participants: [] as Participant[],
  orders: [] as Array<{ id: string; reference: string; currency: string; fxRateToEgp: string; items: unknown[] }>,
  /** Goods + legs + expenses. */
  cycleCost: 10000,
  /** What friends paid, in pounds. */
  financed: 0,
  /** Who they were — what `/cycles/:id/financing` names. */
  lenderNames: [] as string[],
  writes: [] as Array<{ method: string; url: string; body: WriteBody }>,
}));

vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ user: { id: 'u-1', email: 'partner.a@motoparts.com', role: 'CORE_PARTNER' }, isLoading: false }),
}));
vi.mock('next/navigation', () => ({
  useParams: () => ({ cycleId: 'c-1', locale: 'en' }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/en/cycles/c-1/details',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));
// The `+` beside the lender picker opens the Lenders tab's own form; not under test here.
vi.mock('@/components/ui/quick-create', () => ({
  FieldWithQuickCreate: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

/** `profitBasisOf` as the server works it out, over what the fake holds. */
function basis() {
  if (state.participants.some((p) => p.customProfitPct !== null)) return 'CUSTOM_SPLIT';
  const total = state.participants.reduce((s, p) => s + Number(p.contributionAmount), 0);
  if (total > 0) return 'CONTRIBUTIONS';
  return 'NONE';
}

vi.mock('@/lib/api', () => {
  const ok = (data: unknown) => Promise.resolve({ data: { data } });
  return {
    api: {
      get: (url: string) => {
        if (url === '/cycles/c-1') {
          return ok({
            id: 'c-1',
            code: 'CYC-2026-0042',
            status: state.status,
            originType: 'UAE_DIRECT',
            currency: 'AED',
            participants: state.participants,
            purchaseOrders: state.orders,
            shippingLegs: [],
            inventoryBatches: [],
            settlements: [],
            fundingLock: state.fundingLock,
          });
        }
        if (url === '/costing/cycles/c-1/landed-cost') {
          // A friend's payment is a loan the partners repay (2026-10-19): not taken off.
          const toFund = state.cycleCost;
          return Promise.resolve({
            data: {
              totals: {
                landedEgp: state.cycleCost.toFixed(2),
                cycleCostEgp: state.cycleCost.toFixed(2),
                lenderFinancedEgp: state.financed.toFixed(2),
                transferredInEgp: '0.00',
                toFundEgp: toFund.toFixed(2),
                profitBasis: basis(),
              },
            },
          });
        }
        if (url === '/cycles/c-1/financing') {
          return ok({
            financings: state.lenderNames.map((name, i) => ({
              id: `f-${i}`,
              lender: { id: `l-${i}`, name },
              purchaseOrder: { id: 'po-1', reference: 'PO-2026-0041' },
              cycle: { id: 'c-1', code: 'CYC-2026-0042', status: state.status },
              currency: 'EGP',
              amount: '0.00',
              fxRateToEgp: '1',
              amountEgp: '0.00',
              paidOn: '2026-10-01',
              removedAt: null,
              repaid: '0.00',
              owed: '0.00',
              paidEgp: '0.00',
              exchangeDiffEgp: '0.00',
              repayments: [],
              plan: null,
            })),
            cycleCostEgp: state.cycleCost.toFixed(2),
            cycleFinancedEgp: state.financed.toFixed(2),
            availableEgp: Math.max(state.cycleCost - state.financed, 0).toFixed(2),
          });
        }
        if (url === '/cycles/c-1/shipment') {
          return ok({
            cycleId: 'c-1',
            code: 'CYC-2026-0042',
            status: state.status,
            accounted: true,
            totals: { ordered: 0, received: 0, lost: 0, onTheWay: 0, waiting: 0 },
            lines: [],
            legs: [],
          });
        }
        if (url === '/lenders') return ok([{ id: 'l-mohammed', name: 'Mohammed' }]);
        if (url === '/currency-rates/map') return ok({ AED: 13.85 });
        return ok([]);
      },
      put: (url: string, body: WriteBody) => {
        state.writes.push({ method: 'PUT', url, body });
        if (state.fundingLock) {
          return Promise.reject({
            response: {
              status: 400,
              data: {
                error: {
                  code: 'FUNDING_LOCKED_AFTER_SETTLEMENT',
                  message: 'English',
                  params: { cycle: 'CYC-2026-0042', reason: state.fundingLock },
                },
              },
            },
          });
        }
        const p = state.participants.find((x) => url === `/cycles/participants/${x.id}`);
        if (p && body.contributionAmount !== undefined) p.contributionAmount = String(body.contributionAmount);
        return ok(p ?? {});
      },
      post: (url: string, body: WriteBody) => {
        state.writes.push({ method: 'POST', url, body });
        if (url.endsWith('/financings')) {
          const order = state.orders.find((o) => url === `/purchases/${o.id}/financings`)!;
          const rate = body.currency === 'EGP' ? 1 : Number(body.fxRateToEgp ?? order.fxRateToEgp);
          state.financed += Math.round(body.amount * rate * 100) / 100;
          state.lenderNames.push('Mohammed');
        }
        return ok({});
      },
      delete: () => ok({}),
    },
  };
});

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
});

const partner = (n: number, contribution = '0'): Participant => ({
  id: `part-${n}`,
  participantType: 'CORE_PARTNER',
  contributionAmount: contribution,
  customProfitPct: null,
  partner: { email: `p${n}@motoparts.com`, partner: { displayName: `Partner ${n}` } },
});
const order = (n: number, currency = 'EGP', rate = '1') => ({
  id: `po-${n}`,
  reference: `PO-2026-004${n}`,
  currency,
  fxRateToEgp: rate,
  items: [{ id: `poi-${n}` }],
});

beforeEach(() => {
  state.status = 'PURCHASING';
  state.fundingLock = null;
  state.participants = [partner(1), partner(2), partner(3)];
  state.orders = [order(1)];
  state.cycleCost = 10000;
  state.financed = 0;
  state.lenderNames = [];
  state.writes = [];
});
afterEach(() => cleanup());

function wrap(locale: 'en' | 'ar' = 'en') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === 'ar' ? ar : en} timeZone="Africa/Cairo">
      <QueryClientProvider client={client}>
        <ToastProvider>
          <CycleDetailsPage />
        </ToastProvider>
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

const note = () => screen.queryByTestId('funding-note');
/** The page has loaded its cycle and costing: the participants are listed. */
const loaded = () => screen.findByText('Partner 1');
const combobox = (name: string) =>
  document
    .querySelector<HTMLInputElement>(`input[type="hidden"][name="${name}"]`)!
    .parentElement!.querySelector<HTMLElement>('[role="combobox"]')!;
async function pick(name: string, label: string) {
  fireEvent.click(combobox(name));
  fireEvent.click(await screen.findByRole('option', { name: new RegExp(`^${label}`) }));
}
function typeInto(input: HTMLInputElement, value: string) {
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
}
const amount = () => document.querySelector<HTMLInputElement>('#financing-amount')!;

// ─── When it shows ─────────────────────────────────────────────────────────

describe('the funding note shows while settling would be refused', () => {
  it('zero contributions and no friend paid: the note, near the top, with its three actions', async () => {
    wrap();
    const shown = await screen.findByTestId('funding-note');
    expect(shown.textContent).toContain(en.cycles.fundingNoteTitle);
    expect(within(shown).getByTestId('funding-note-split').textContent).toContain(en.cycles.splitEqually);
    expect(within(shown).getByTestId('funding-note-enter').textContent).toContain(en.cycles.fundingEnterAmounts);
    expect(within(shown).getByTestId('funding-note-lender').textContent).toContain(en.cycles.fundingPaidByLender);
    // Above the cards: before the participants it asks about.
    const participants = screen.getByTestId('participants-card');
    expect(shown.compareDocumentPosition(participants) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Every button inside the page says what it is (CLAUDE.md §13).
    for (const b of within(shown).getAllByRole('button')) expect(b.getAttribute('type')).toBe('button');
  });

  it('the partners have put money in: no note', async () => {
    state.participants = [partner(1, '5000'), partner(2, '5000'), partner(3, '0')];
    wrap();
    await loaded();
    await waitFor(() => expect(screen.getByText(/CYC-2026-0042/)).toBeTruthy());
    expect(note()).toBeNull();
  });

  it('a friend paid the whole cycle and the partners nothing: the note stays, names him and asks who repays him (2026-10-19)', async () => {
    // The owner's case: "it looks vague as if we payed nothing".
    state.cycleCost = 172155.5;
    state.financed = 172155.5;
    state.lenderNames = ['Ahmad Eraiby'];
    wrap();
    const title = await screen.findByTestId('funding-note-title');
    expect(title.textContent?.replace(/\u00a0/g, ' ')).toBe(
      'Ahmad Eraiby paid 172,155.50 EGP for this cycle. Split who repays him between the partners.',
    );
    const shown = note()!;
    expect(shown.textContent).toContain(en.cycles.fundingNoteLenderHint);
    expect(within(shown).getByTestId('funding-note-split').textContent).toContain(en.cycles.splitEqually);
    expect(within(shown).getByTestId('funding-note-enter').textContent).toContain(en.cycles.fundingEnterAmounts);
  });

  it('two friends paid it: both named, and "them"', async () => {
    state.financed = 10000;
    state.lenderNames = ['Ahmad Eraiby', 'Mohamed Abu Setta'];
    wrap();
    const title = await screen.findByTestId('funding-note-title');
    expect(title.textContent).toMatch(/^Ahmad Eraiby and Mohamed Abu Setta paid 10,000\.00 EGP for this cycle\. Split who repays them between the partners\.$/);
  });

  it('in Arabic: the friend paid, the partners repay him', async () => {
    state.financed = 10000;
    state.lenderNames = ['Ahmad Eraiby'];
    wrap('ar');
    const title = await screen.findByTestId('funding-note-title');
    expect(title.textContent).toContain('دفع Ahmad Eraiby');
    expect(title.textContent).toContain('10,000.00');
    expect(title.textContent).toContain('من يسدّد له');
  });

  it('a friend paid part and the partners nothing: the note stays, and says how much of what', async () => {
    state.financed = 4000;
    state.lenderNames = ['Mohammed'];
    wrap();
    const title = await screen.findByTestId('funding-note-title');
    expect(title.textContent).toMatch(/Mohammed paid 4,000\.00 EGP of this cycle's 10,000\.00 EGP/);
    expect(title.textContent).toMatch(/they repay him and fund the rest/);
  });

  it('in Arabic too — the partial text with its figures; with no name loaded yet, "a lender"', async () => {
    state.financed = 4000;
    wrap('ar');
    const title = await screen.findByTestId('funding-note-title');
    expect(title.textContent).toContain('دفع مُقرض');
    expect(title.textContent).toContain('4,000.00');
    expect(title.textContent).toContain('10,000.00');
  });

  it('an agreed custom split is a basis too: no note', async () => {
    state.participants = [
      { ...partner(1), customProfitPct: '50' },
      { ...partner(2), customProfitPct: '50' },
    ];
    wrap();
    await loaded();
    expect(note()).toBeNull();
  });

  it('nothing for a closed or cancelled cycle', async () => {
    for (const status of ['CLOSED', 'CANCELLED']) {
      state.status = status;
      wrap();
      await loaded();
      expect([status, note()]).toEqual([status, null]);
      cleanup();
    }
  });
});

// ─── The three actions ─────────────────────────────────────────────────────

describe('the funding note’s actions', () => {
  it('Split equally writes each partner’s third of what is left to fund, and the note goes', async () => {
    wrap();
    fireEvent.click(await screen.findByTestId('funding-note-split'));
    await waitFor(() => expect(state.writes).toHaveLength(3));
    expect(state.writes.map((w) => [w.url, w.body.contributionAmount])).toEqual([
      ['/cycles/participants/part-1', 3333.33],
      ['/cycles/participants/part-2', 3333.33],
      ['/cycles/participants/part-3', 3333.34],
    ]);
    await waitFor(() => expect(note()).toBeNull());
  });

  it('Split equally on a cycle a friend paid for divides the whole cost — each partner’s share of repaying him — and the note goes', async () => {
    state.financed = 10000;
    state.lenderNames = ['Mohammed'];
    wrap();
    fireEvent.click(await screen.findByTestId('funding-note-split'));
    await waitFor(() => expect(state.writes).toHaveLength(3));
    expect(state.writes.map((w) => w.body.contributionAmount)).toEqual([3333.33, 3333.33, 3333.34]);
    await waitFor(() => expect(note()).toBeNull());
    // The participants card now says what those amounts are.
    expect((await screen.findByTestId('repay-shares')).textContent).toContain("Each partner's share of repaying Mohammed:");
  });

  it('Split equally on a cycle a friend paid only part of still divides the whole cost', async () => {
    state.financed = 4000;
    wrap();
    fireEvent.click(await screen.findByTestId('funding-note-split'));
    await waitFor(() => expect(state.writes).toHaveLength(3));
    expect(state.writes.map((w) => w.body.contributionAmount)).toEqual([3333.33, 3333.33, 3333.34]);
  });

  it('Enter amounts on the owner’s cycle: 30 / 30 / 40 % of 172,155.50 fills amounts that sum exactly, and Save writes them', async () => {
    state.cycleCost = 172155.5;
    state.financed = 172155.5;
    state.lenderNames = ['Ahmad Eraiby'];
    wrap();
    fireEvent.click(await screen.findByTestId('funding-note-enter'));
    const form = await screen.findByTestId('amounts-form');
    const pct = (n: number) => form.querySelector<HTMLInputElement>(`input[data-field="pct-part-${n}"]`)!;
    const amountOf = (n: number) =>
      form.querySelector<HTMLInputElement>(`input[data-field="contribution-part-${n}"]`)!.value.replace(/,/g, '');
    typeInto(pct(1), '30');
    typeInto(pct(2), '30');
    typeInto(pct(3), '40');
    expect([amountOf(1), amountOf(2), amountOf(3)]).toEqual(['51646.65', '51646.65', '68862.20']);
    expect(within(form).getByTestId('amounts-gap').textContent).toBe(en.cycles.amountsMatch);
    expect(within(form).queryByTestId('amounts-pct-warning')).toBeNull();
    fireEvent.click(within(form).getByRole('button', { name: en.common.save }));
    await waitFor(() => expect(state.writes).toHaveLength(3));
    expect(state.writes.map((w) => [w.url, w.body.contributionAmount])).toEqual([
      ['/cycles/participants/part-1', 51646.65],
      ['/cycles/participants/part-2', 51646.65],
      ['/cycles/participants/part-3', 68862.2],
    ]);
    await waitFor(() => expect(note()).toBeNull());
    const shares = await screen.findByTestId('repay-shares');
    expect(shares.textContent).toContain("Each partner's share of repaying Ahmad Eraiby:");
    expect(screen.getByTestId('repay-share-part-3').textContent?.replace(/\u00a0/g, ' ')).toBe('Partner 3 68,862.20 EGP (40%)');
  });

  it('Enter amounts opens each participant’s contribution, recorded value first; Save writes only what changed and the note goes', async () => {
    wrap();
    fireEvent.click(await screen.findByTestId('funding-note-enter'));
    const form = await screen.findByTestId('amounts-form');
    const inputs = form.querySelectorAll<HTMLInputElement>('input[data-field^="contribution-"]');
    expect(inputs).toHaveLength(3);
    // Zero shows as empty, so typing starts clean (not "09").
    expect([...inputs].map((i) => i.value)).toEqual(['', '', '']);
    typeInto(inputs[0], '6000');
    typeInto(inputs[1], '4000');
    fireEvent.click(within(form).getByRole('button', { name: en.common.save }));
    await waitFor(() => expect(state.writes).toHaveLength(2));
    expect(state.writes.map((w) => [w.url, w.body.contributionAmount])).toEqual([
      ['/cycles/participants/part-1', 6000],
      ['/cycles/participants/part-2', 4000],
    ]);
    await waitFor(() => expect(note()).toBeNull());
    expect(screen.queryByTestId('amounts-form')).toBeNull();
  });

  it('the second time: Enter amounts on a cycle already funded starts from what is recorded', async () => {
    state.participants = [partner(1, '6000'), partner(2, '4000'), partner(3, '0')];
    wrap();
    await loaded();
    fireEvent.click(screen.getByTestId('edit-amounts'));
    const inputs = (await screen.findByTestId('amounts-form')).querySelectorAll<HTMLInputElement>('input[data-field^="contribution-"]');
    expect([...inputs].map((i) => i.value.replace(/,/g, ''))).toEqual(['6000.00', '4000.00', '']);
  });

  it('Enter amounts, then Cancel: nothing written, the list is back', async () => {
    wrap();
    fireEvent.click(await screen.findByTestId('funding-note-enter'));
    const form = await screen.findByTestId('amounts-form');
    typeInto(form.querySelector<HTMLInputElement>('input[data-field^="contribution-"]')!, '999');
    fireEvent.click(within(form).getByRole('button', { name: en.common.cancel }));
    expect(screen.queryByTestId('amounts-form')).toBeNull();
    expect(state.writes).toEqual([]);
    expect(note()).toBeTruthy();
  });

  it('Paid by a lender, one order: the friend’s form opens on it, the amount is what is still unpaid', async () => {
    wrap();
    fireEvent.click(await screen.findByTestId('funding-note-lender'));
    expect(await screen.findByTestId('financing-form')).toBeTruthy();
    // One order: nothing to pick.
    expect(document.querySelector('input[type="hidden"][name="purchaseOrderId"]')).toBeNull();
    await waitFor(() => expect(amount().value.replace(/,/g, '')).toBe('10000.00'));
  });

  it('Paid by a lender on an AED order: the unpaid pounds in dirhams at the order’s rate, never above it', async () => {
    state.orders = [order(1, 'AED', '13')];
    state.cycleCost = 13000.05;
    wrap();
    fireEvent.click(await screen.findByTestId('funding-note-lender'));
    // 13,000.05 / 13 = 1,000.0038… → 1,000.00 (rounded down: never more than is left).
    await waitFor(() => expect(amount().value.replace(/,/g, '')).toBe('1000.00'));
  });

  it('Paid by a lender, several orders: they pick one; then the amount follows', async () => {
    state.orders = [order(1), order(2, 'AED', '13')];
    wrap();
    fireEvent.click(await screen.findByTestId('funding-note-lender'));
    await screen.findByTestId('financing-form');
    expect(document.querySelector<HTMLInputElement>('input[type="hidden"][name="purchaseOrderId"]')!.value).toBe('');
    expect(amount().value).toBe('');
    await pick('purchaseOrderId', 'PO-2026-0042');
    await waitFor(() => expect(amount().value.replace(/,/g, '')).toBe('769.23'));
  });

  it('a typed amount is his: changing the rate never overwrites it', async () => {
    state.orders = [order(1, 'AED', '13')];
    wrap();
    fireEvent.click(await screen.findByTestId('funding-note-lender'));
    await waitFor(() => expect(amount().value).not.toBe(''));
    typeInto(amount(), '500');
    typeInto(screen.getByTestId('financing-rate') as HTMLInputElement, '14');
    expect(amount().value).toBe('500');
  });

  it('saving the friend’s payment for all of it: the note stays and names him — the partners still split repaying him', async () => {
    wrap();
    fireEvent.click(await screen.findByTestId('funding-note-lender'));
    await screen.findByTestId('financing-form');
    await waitFor(() => expect(amount().value.replace(/,/g, '')).toBe('10000.00'));
    await pick('lenderId', 'Mohammed');
    fireEvent.click(screen.getByRole('button', { name: en.lenders.save }));
    await waitFor(() => expect(state.writes.some((w) => w.url === '/purchases/po-1/financings')).toBe(true));
    expect(state.writes.find((w) => w.url === '/purchases/po-1/financings')!.body).toMatchObject({
      lenderId: 'l-mohammed',
      amount: 10000,
      currency: 'EGP',
    });
    await waitFor(() =>
      expect(screen.getByTestId('funding-note-title').textContent).toMatch(
        /^Mohammed paid 10,000\.00 EGP for this cycle\. Split who repays him between the partners\.$/,
      ),
    );
  });

  it('a friend paying only part: the note stays and turns to the partial text', async () => {
    wrap();
    fireEvent.click(await screen.findByTestId('funding-note-lender'));
    await screen.findByTestId('financing-form');
    await pick('lenderId', 'Mohammed');
    typeInto(amount(), '2500');
    fireEvent.click(screen.getByRole('button', { name: en.lenders.save }));
    await waitFor(() =>
      expect(screen.getByTestId('funding-note-title').textContent).toMatch(/Mohammed paid 2,500\.00 EGP of this cycle's 10,000\.00 EGP/),
    );
  });

  it('the opened form’s Cancel closes it; opening it by hand afterwards starts blank', async () => {
    wrap();
    fireEvent.click(await screen.findByTestId('funding-note-lender'));
    await screen.findByTestId('financing-form');
    fireEvent.click(screen.getByRole('button', { name: en.common.cancel }));
    expect(screen.queryByTestId('financing-form')).toBeNull();
    fireEvent.click(screen.getByTestId('add-financing'));
    await screen.findByTestId('financing-form');
    expect(amount().value).toBe('');
  });
});

// ─── Locked ────────────────────────────────────────────────────────────────

describe('funding locked once the settlement is approved', () => {
  for (const [lock, status] of [
    ['SETTLEMENT_APPROVED', 'SETTLEMENT'],
    ['SETTLEMENT_PAID', 'CLOSED'],
    ['CYCLE_CLOSED', 'CLOSED'],
  ] as const) {
    it(`${lock}: no note, and every funding control is switched off with the reason beside it`, async () => {
      state.fundingLock = lock;
      state.status = status;
      wrap();
      await loaded();
      expect(note()).toBeNull();
      const reason = en.cycles.fundingLocked.replace('{reason}', en.codes.fundingLock[lock]);
      expect(screen.getByTestId('funding-locked').textContent).toBe(reason);
      const add = screen.getByRole('button', { name: new RegExp(en.cycles.addParticipant, 'i') });
      const edit = screen.getByTestId('edit-amounts');
      const split = screen.getByRole('button', { name: en.cycles.splitEqually });
      for (const b of [add, edit, split]) {
        expect((b as HTMLButtonElement).disabled).toBe(true);
        expect(b.getAttribute('title')).toBe(reason);
      }
      // The friend's payment says it too, instead of the button just vanishing.
      expect(screen.getByTestId('financing-locked').textContent).toBe(reason);
      expect(screen.queryByTestId('add-financing')).toBeNull();
      expect(state.writes).toEqual([]);
    });
  }

  it('in Arabic, the reason reads in Arabic', async () => {
    state.fundingLock = 'SETTLEMENT_APPROVED';
    state.status = 'SETTLEMENT';
    wrap('ar');
    await loaded();
    expect(screen.getByTestId('funding-locked').textContent).toContain(ar.codes.fundingLock.SETTLEMENT_APPROVED);
  });
});

describe('remainingIn — the unpaid pounds in his currency', () => {
  it('pounds as they are; another currency rounded down; nothing left or no rate is blank', () => {
    expect(remainingIn('10000.00', '1')).toBe('10000.00');
    expect(remainingIn('13000.05', '13')).toBe('1000.00');
    expect(remainingIn('10000.00', '13')).toBe('769.23');
    expect(remainingIn('0.00', '13')).toBe('');
    expect(remainingIn('100', '')).toBe('');
    expect(remainingIn(undefined, '13')).toBe('');
  });
});
