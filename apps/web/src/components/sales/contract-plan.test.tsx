import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/i18n/locales/en.json';
import { ToastProvider } from '@/components/ui/toast';
import { businessToday } from '@/lib/dates';
import {
  ContractButton,
  ContractPlanDialog,
  addMonths,
  canAgreeContract,
  splitEqually,
  type ContractSale,
} from './contract-plan';

/**
 * The sale contract's button and plan popup (BUSINESS_LOGIC §7, 2026-10-16).
 */

const state = vi.hoisted(() => ({
  role: 'CORE_PARTNER',
  push: vi.fn(),
  posts: [] as { url: string; body: unknown }[],
  answer: (() => new Promise(() => {})) as () => Promise<unknown>,
}));

vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ user: { id: 'u-1', email: 'x@y.z', role: state.role }, isLoading: false }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: state.push, replace: vi.fn() }),
  useParams: () => ({ locale: 'en' }),
  usePathname: () => '/en/sales',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/api', () => ({
  api: {
    post: (url: string, body: unknown) => {
      state.posts.push({ url, body });
      return state.answer();
    },
    get: () => Promise.resolve({ data: { data: [] } }),
  },
}));
// The shared calendar is a popover jsdom cannot lay out; a plain field with the
// same contract (a YYYY-MM-DD value in, one out) stands in for it here.
vi.mock('@/components/ui/date-picker', () => ({
  DatePicker: ({ id, value, onChange, placeholder }: { id?: string; value?: string; onChange?: (v: string) => void; placeholder?: string }) => (
    <input data-testid={`date-${id}`} value={value ?? ''} placeholder={placeholder} onChange={(e) => onChange?.(e.target.value)} />
  ),
}));

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
});

const SALE: ContractSale = {
  id: 'sale-1',
  orderNo: 'ORD-2026-00001',
  status: 'PARTIALLY_PAID',
  currency: 'EGP',
  total: '35200.00',
  outstanding: '25200.00',
  customer: { isWalkIn: false },
  contractPlan: null,
};

function wrap(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="Africa/Cairo">
      <QueryClientProvider client={client}>
        <ToastProvider>{node}</ToastProvider>
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  state.role = 'CORE_PARTNER';
  state.push.mockReset();
  state.posts = [];
  state.answer = () => new Promise(() => {});
});
afterEach(() => cleanup());

describe('which sales offer a contract', () => {
  it('a confirmed or partly paid EGP sale with something outstanding, no plan, not a walk-in', () => {
    expect(canAgreeContract(SALE)).toBe(true);
    expect(canAgreeContract({ ...SALE, status: 'CONFIRMED' })).toBe(true);
  });

  it.each([
    ['a draft', { status: 'DRAFT' }],
    ['a paid sale', { status: 'PAID', outstanding: '0' }],
    ['a cancelled sale', { status: 'CANCELLED' }],
    ['a returned sale', { status: 'RETURNED' }],
    ['a USD sale', { currency: 'USD' }],
    ['nothing outstanding', { outstanding: '0.00' }],
    ['a walk-in', { customer: { isWalkIn: true } }],
    ['a sale that already has its plan', { contractPlan: { id: 'p', reference: 'PLAN-2026-0001', status: 'ACTIVE' } }],
  ])('not %s', (_name, change) => {
    expect(canAgreeContract({ ...SALE, ...change } as ContractSale)).toBe(false);
  });
});

describe('the Contract button', () => {
  it('shows for an eligible sale and opens the plan popup', () => {
    const onAgree = vi.fn();
    wrap(<ContractButton sale={SALE} onAgree={onAgree} />);
    fireEvent.click(screen.getByTestId('order-contract'));
    expect(onAgree).toHaveBeenCalledOnce();
    expect(state.push).not.toHaveBeenCalled();
  });

  it('does not show for a draft, a paid sale or a USD sale', () => {
    for (const change of [{ status: 'DRAFT' }, { status: 'PAID', outstanding: '0' }, { currency: 'USD' }]) {
      wrap(<ContractButton sale={{ ...SALE, ...change }} onAgree={vi.fn()} />);
      expect(screen.queryByTestId('order-contract')).toBeNull();
      cleanup();
    }
  });

  it('a sale with its plan shows the button, and it opens the contract directly — no popup', () => {
    const onAgree = vi.fn();
    const withPlan = { ...SALE, status: 'PAID', outstanding: '0', contractPlan: { id: 'p', reference: 'PLAN-2026-0001', status: 'ACTIVE' } };
    wrap(<ContractButton sale={withPlan} onAgree={onAgree} />);
    fireEvent.click(screen.getByTestId('order-contract'));
    expect(state.push).toHaveBeenCalledWith('/en/sales/sale-1/contract');
    expect(onAgree).not.toHaveBeenCalled();
  });

  it('admin support may open an existing contract but is not offered a new plan (POST is partners only)', () => {
    state.role = 'ADMIN_SUPPORT';
    wrap(<ContractButton sale={SALE} onAgree={vi.fn()} />);
    expect(screen.queryByTestId('order-contract')).toBeNull();
    cleanup();
    wrap(<ContractButton sale={{ ...SALE, contractPlan: { id: 'p', reference: 'R', status: 'ACTIVE' } }} onAgree={vi.fn()} />);
    expect(screen.getByTestId('order-contract')).toBeTruthy();
  });
});

describe('the rows: one a month, equal amounts', () => {
  it('months are counted from the first date, clamped to the month end, never drifting', () => {
    expect([0, 1, 2, 3].map((i) => addMonths('2026-01-31', i))).toEqual([
      '2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30',
    ]);
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonths('2026-11-15', 2)).toBe('2027-01-15');
  });

  it('the last row absorbs the rounding, and the rows add up to the total to the piastre', () => {
    expect(splitEqually('100.00', 3)).toEqual(['33.33', '33.33', '33.34']);
    expect(splitEqually('25200', 3)).toEqual(['8400.00', '8400.00', '8400.00']);
    const odd = splitEqually('1000.01', 7);
    expect(odd.reduce((s, a) => s + Math.round(Number(a) * 100), 0)).toBe(100001);
  });
});

const amount = (i: number) => screen.getByTestId(`contract-amount-${i}`) as HTMLInputElement;
const dateOf = (i: number) => screen.getByTestId(`date-contract-due-${i}`) as HTMLInputElement;
const createBtn = () => screen.getByTestId('contract-create') as HTMLButtonElement;
function typeInto(input: HTMLInputElement, value: string) {
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
}

describe('the plan popup', () => {
  it('shows the total, paid so far and remaining, and three equal rows a month apart from a month from today', () => {
    wrap(<ContractPlanDialog sale={SALE} onClose={vi.fn()} />);
    const dialog = screen.getByTestId('contract-plan-dialog');
    expect(dialog.textContent).toContain('35,200.00');
    expect(dialog.textContent).toContain('10,000.00');
    expect(screen.getByTestId('contract-remaining').textContent).toContain('25,200.00');

    const first = addMonths(businessToday(), 1);
    expect((screen.getByTestId('date-contract-first-due') as HTMLInputElement).value).toBe(first);
    expect([0, 1, 2].map((i) => amount(i).value)).toEqual(['8,400.00', '8,400.00', '8,400.00']);
    expect([0, 1, 2].map((i) => dateOf(i).value)).toEqual([first, addMonths(first, 1), addMonths(first, 2)]);
    expect(screen.queryByTestId('contract-amount-3')).toBeNull();
    expect(createBtn().disabled).toBe(false);
  });

  it('blocks Create while the rows do not add up, saying by how much, and allows it once they do', () => {
    wrap(<ContractPlanDialog sale={SALE} onClose={vi.fn()} />);
    typeInto(amount(1), '9000');
    expect(screen.getByTestId('contract-difference').textContent).toBe('600.00 EGP more than the remaining amount');
    expect(createBtn().disabled).toBe(true);

    typeInto(amount(2), '7700');
    expect(screen.getByTestId('contract-difference').textContent).toBe('100.00 EGP short of the remaining amount');
    expect(createBtn().disabled).toBe(true);

    typeInto(amount(2), '7800');
    expect(screen.getByTestId('contract-difference').textContent).toBe('Matches the remaining amount');
    expect(createBtn().disabled).toBe(false);
  });

  it("keeps the user's edits when the first date moves: only untouched rows are re-dated", () => {
    wrap(<ContractPlanDialog sale={SALE} onClose={vi.fn()} />);
    const later = addMonths(businessToday(), 4);
    typeInto(amount(1), '9000');
    fireEvent.change(dateOf(2), { target: { value: later } });

    const newFirst = addMonths(businessToday(), 2);
    fireEvent.change(screen.getByTestId('date-contract-first-due'), { target: { value: newFirst } });

    expect(amount(1).value).toBe('9,000');
    expect(dateOf(0).value).toBe(newFirst);
    expect(dateOf(1).value).toBe(addMonths(newFirst, 1));
    expect(dateOf(2).value).toBe(later);
  });

  it('a new number of instalments re-splits the amounts equally and keeps hand-typed dates', () => {
    wrap(<ContractPlanDialog sale={SALE} onClose={vi.fn()} />);
    const later = addMonths(businessToday(), 6);
    typeInto(amount(0), '1000');
    fireEvent.change(dateOf(0), { target: { value: later } });
    fireEvent.change(screen.getByTestId('contract-count'), { target: { value: '4' } });

    expect([0, 1, 2, 3].map((i) => amount(i).value)).toEqual(['6,300.00', '6,300.00', '6,300.00', '6,300.00']);
    expect(dateOf(0).value).toBe(later);
    expect(createBtn().disabled).toBe(false);
  });

  it('no instalments, more than 36, or letters: no rows, a reason, and Create disabled', () => {
    wrap(<ContractPlanDialog sale={SALE} onClose={vi.fn()} />);
    for (const v of ['0', '37', '']) {
      fireEvent.change(screen.getByTestId('contract-count'), { target: { value: v } });
      expect(screen.getByTestId('contract-count-error').textContent).toBe('Between 1 and 36 instalments');
      expect(screen.queryByTestId('contract-amount-0')).toBeNull();
      expect(createBtn().disabled).toBe(true);
    }
    fireEvent.change(screen.getByTestId('contract-count'), { target: { value: 'abc' } });
    expect((screen.getByTestId('contract-count') as HTMLInputElement).value).toBe('');
  });

  it('a row dated in the past blocks Create; the server would refuse it', () => {
    wrap(<ContractPlanDialog sale={SALE} onClose={vi.fn()} />);
    expect(createBtn().disabled).toBe(false);
    fireEvent.change(dateOf(0), { target: { value: '2020-01-01' } });
    expect(createBtn().disabled).toBe(true);
  });

  it('posts exactly the rows on screen to the sale, then closes and opens the contract', async () => {
    state.answer = () => Promise.resolve({ data: { data: { id: 'plan-1' } } });
    const onClose = vi.fn();
    wrap(<ContractPlanDialog sale={SALE} onClose={onClose} />);
    typeInto(amount(0), '10000');
    typeInto(amount(2), '6800');
    const days = [0, 1, 2].map((i) => dateOf(i).value);
    fireEvent.click(createBtn());

    await waitFor(() => expect(state.push).toHaveBeenCalledWith('/en/sales/sale-1/contract'));
    expect(state.posts).toEqual([
      {
        url: '/sales/orders/sale-1/contract-plan',
        body: {
          instalments: [
            { dueOn: days[0], amount: 10000 },
            { dueOn: days[1], amount: 8400 },
            { dueOn: days[2], amount: 6800 },
          ],
        },
      },
    ]);
    expect(onClose).toHaveBeenCalled();
  });

  it('busy while saving: Create disabled, so a second click sends nothing', async () => {
    wrap(<ContractPlanDialog sale={SALE} onClose={vi.fn()} />);
    fireEvent.click(createBtn());
    await waitFor(() => expect(createBtn().disabled).toBe(true));
    fireEvent.click(createBtn());
    expect(state.posts).toHaveLength(1);
  });

  it('a refusal is said in words and the popup stays open with the rows as typed', async () => {
    state.answer = () =>
      Promise.reject({
        response: { data: { error: { code: 'CUSTOMER_HAS_ACTIVE_PLAN', message: 'x', params: { customer: 'Al Nour', reference: 'PLAN-2026-0003' } } } },
      });
    const onClose = vi.fn();
    wrap(<ContractPlanDialog sale={SALE} onClose={onClose} />);
    typeInto(amount(0), '10000');
    typeInto(amount(2), '6800');
    await act(async () => {
      fireEvent.click(createBtn());
    });
    await waitFor(() => expect(document.body.textContent).toContain('Al Nour already has an active plan (PLAN-2026-0003)'));
    expect(onClose).not.toHaveBeenCalled();
    expect(amount(0).value).toBe('10,000');
  });
});
