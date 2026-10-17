import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/i18n/locales/en.json';
import ar from '@/i18n/locales/ar.json';
import { ToastProvider } from '@/components/ui/toast';
import { businessToday } from '@/lib/dates';
import {
  ContractButton,
  ContractPlanDialog,
  addMonths,
  canAgreeContract,
  nextSaturday,
  splitEqually,
  stepDate,
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
  // The shared Select's empty state links through next-intl's navigation,
  // which reads these when it is built.
  redirect: vi.fn(),
  permanentRedirect: vi.fn(),
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

function wrap(node: React.ReactNode, locale: 'en' | 'ar' = 'en') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : ar} timeZone="Africa/Cairo">
      <QueryClientProvider client={client}>
        <ToastProvider>
          <div dir={locale === 'ar' ? 'rtl' : 'ltr'}>{node}</div>
        </ToastProvider>
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

describe('the first Saturday after a day', () => {
  it('is never the day itself: a Saturday is first due the Saturday after', () => {
    expect(nextSaturday('2026-10-17')).toBe('2026-10-24'); // Saturday
    expect(nextSaturday('2026-10-16')).toBe('2026-10-17'); // Friday
    expect(nextSaturday('2026-10-18')).toBe('2026-10-24'); // Sunday
  });

  it('crosses a month and a year end', () => {
    expect(nextSaturday('2026-10-29')).toBe('2026-10-31');
    expect(nextSaturday('2026-10-31')).toBe('2026-11-07');
    expect(nextSaturday('2026-12-31')).toBe('2027-01-02');
    expect(nextSaturday('2028-02-28')).toBe('2028-03-04');
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

async function pickInterval(label: string) {
  const dialog = screen.getByTestId('contract-plan-dialog');
  fireEvent.click(within(dialog).getByRole('combobox'));
  fireEvent.click(await screen.findByRole('option', { name: label }));
}

/**
 * The popup set to three monthly rows from a month today, through its own
 * fields — the starting point most of these tests were written against before
 * the default became two Saturdays (owner, 2026-10-17).
 */
async function openMonthlyPlan(sale: ContractSale = SALE, onClose: () => void = vi.fn(), locale: 'en' | 'ar' = 'en') {
  wrap(<ContractPlanDialog sale={sale} onClose={onClose} />, locale);
  await pickInterval(locale === 'ar' ? 'شهر' : 'Month');
  fireEvent.change(screen.getByTestId('contract-count'), { target: { value: '3' } });
  fireEvent.change(screen.getByTestId('date-contract-first-due'), { target: { value: addMonths(businessToday(), 1) } });
}

const amount = (i: number) => screen.getByTestId(`contract-amount-${i}`) as HTMLInputElement;
const dateOf = (i: number) => screen.getByTestId(`date-contract-due-${i}`) as HTMLInputElement;
const createBtn = () => screen.getByTestId('contract-create') as HTMLButtonElement;
function typeInto(input: HTMLInputElement, value: string) {
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
}

describe('the plan popup', () => {
  it('opens on two weekly instalments on the next two Saturdays, the remaining split between them', () => {
    wrap(<ContractPlanDialog sale={SALE} onClose={vi.fn()} />);
    const dialog = screen.getByTestId('contract-plan-dialog');
    expect(dialog.textContent).toContain('35,200.00');
    expect(dialog.textContent).toContain('10,000.00');
    expect(screen.getByTestId('contract-remaining').textContent).toContain('25,200.00');

    const first = nextSaturday(businessToday());
    expect(new Date(`${first}T00:00:00Z`).getUTCDay()).toBe(6);
    expect(first > businessToday()).toBe(true);
    expect((screen.getByTestId('contract-count') as HTMLInputElement).value).toBe('2');
    expect(within(dialog).getByRole('combobox').textContent).toContain('Week');
    expect((screen.getByTestId('date-contract-first-due') as HTMLInputElement).value).toBe(first);
    expect([0, 1].map((i) => amount(i).value)).toEqual(['12,600.00', '12,600.00']);
    expect([0, 1].map((i) => dateOf(i).value)).toEqual([first, stepDate(first, 'week', 1)]);
    expect(screen.queryByTestId('contract-amount-2')).toBeNull();
    expect(createBtn().disabled).toBe(false);
  });

  it('blocks Create while the rows do not add up, saying by how much, and allows it once they do', async () => {
    await openMonthlyPlan(SALE, vi.fn());
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

  it("keeps the user's edits when the first date moves: only untouched rows are re-dated", async () => {
    await openMonthlyPlan(SALE, vi.fn());
    const later = addMonths(businessToday(), 5);
    typeInto(amount(1), '9000');
    fireEvent.change(dateOf(2), { target: { value: later } });

    const newFirst = addMonths(businessToday(), 2);
    fireEvent.change(screen.getByTestId('date-contract-first-due'), { target: { value: newFirst } });

    expect(amount(1).value).toBe('9,000');
    expect(dateOf(0).value).toBe(newFirst);
    expect(dateOf(1).value).toBe(addMonths(newFirst, 1));
    expect(dateOf(2).value).toBe(later);
  });

  it('a new number of instalments re-splits the amounts equally and keeps hand-typed dates', async () => {
    await openMonthlyPlan(SALE, vi.fn());
    const later = addMonths(businessToday(), 6);
    typeInto(amount(0), '1000');
    fireEvent.change(dateOf(0), { target: { value: later } });
    fireEvent.change(screen.getByTestId('contract-count'), { target: { value: '4' } });

    expect([0, 1, 2, 3].map((i) => amount(i).value)).toEqual(['6,300.00', '6,300.00', '6,300.00', '6,300.00']);
    expect(dateOf(0).value).toBe(later);
    expect(createBtn().disabled).toBe(false);
  });

  it('no instalments, more than 36, or letters: no rows, a reason, and Create disabled', async () => {
    await openMonthlyPlan(SALE, vi.fn());
    for (const v of ['0', '37', '']) {
      fireEvent.change(screen.getByTestId('contract-count'), { target: { value: v } });
      expect(screen.getByTestId('contract-count-error').textContent).toBe('Between 1 and 36 instalments');
      expect(screen.queryByTestId('contract-amount-0')).toBeNull();
      expect(createBtn().disabled).toBe(true);
    }
    fireEvent.change(screen.getByTestId('contract-count'), { target: { value: 'abc' } });
    expect((screen.getByTestId('contract-count') as HTMLInputElement).value).toBe('');
  });

  it('a row dated in the past blocks Create; the server would refuse it', async () => {
    await openMonthlyPlan(SALE, vi.fn());
    expect(createBtn().disabled).toBe(false);
    fireEvent.change(dateOf(0), { target: { value: '2020-01-01' } });
    expect(createBtn().disabled).toBe(true);
  });

  it('posts exactly the rows on screen to the sale, then closes and opens the contract', async () => {
    state.answer = () => Promise.resolve({ data: { data: { id: 'plan-1' } } });
    const onClose = vi.fn();
    await openMonthlyPlan(SALE, onClose);
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
    await openMonthlyPlan(SALE, vi.fn());
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
    await openMonthlyPlan(SALE, onClose);
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

describe('stepping dates by the interval (§7, 2026-10-17)', () => {
  it('row 0 is the first date itself, whatever the interval', () => {
    for (const k of ['week', 'twoWeeks', 'month', 'twoMonths', 'threeMonths'] as const) {
      expect(stepDate('2026-10-31', k, 0)).toBe('2026-10-31');
    }
  });

  it('weeks are seven days each, across a month end and a year end', () => {
    expect([1, 2, 3].map((n) => stepDate('2026-12-21', 'week', n))).toEqual(['2026-12-28', '2027-01-04', '2027-01-11']);
    expect(stepDate('2026-10-30', 'twoWeeks', 1)).toBe('2026-11-13');
    expect(stepDate('2026-10-30', 'twoWeeks', 3)).toBe('2026-12-11');
  });

  it('weeks over February count its 29th in a leap year and not otherwise', () => {
    expect(stepDate('2028-02-22', 'twoWeeks', 1)).toBe('2028-03-07');
    expect(stepDate('2027-02-22', 'twoWeeks', 1)).toBe('2027-03-08');
    expect(stepDate('2028-02-28', 'week', 1)).toBe('2028-03-06');
  });

  it('months are counted from the first date and clamped to the month end, never drifting', () => {
    expect([1, 2, 3].map((n) => stepDate('2026-01-31', 'month', n))).toEqual(['2026-02-28', '2026-03-31', '2026-04-30']);
    expect([1, 2].map((n) => stepDate('2026-12-31', 'twoMonths', n))).toEqual(['2027-02-28', '2027-04-30']);
    expect(stepDate('2026-11-30', 'threeMonths', 1)).toBe('2027-02-28');
    expect(stepDate('2027-11-30', 'threeMonths', 1)).toBe('2028-02-29');
    expect(stepDate('2028-02-29', 'month', 12)).toBe('2029-02-28');
    expect(stepDate('2026-10-31', 'threeMonths', 4)).toBe('2027-10-31');
  });
});

const countField = () => screen.getByTestId('contract-count') as HTMLInputElement;
const addBtn = () => screen.getByTestId('contract-add-row') as HTMLButtonElement;
const splitBtn = () => screen.getByTestId('contract-split') as HTMLButtonElement;
const removeBtn = (i: number) => screen.getByTestId(`contract-remove-${i}`) as HTMLButtonElement;
const shownAmounts = () => screen.queryAllByTestId(/^contract-amount-\d+$/).map((el) => (el as HTMLInputElement).value);
const firstDueField = () => screen.getByTestId('date-contract-first-due') as HTMLInputElement;

describe('the plan popup: a plan for each contract (§7, 2026-10-17)', () => {
  it('the interval defaults to a week and offers week, 2 weeks, month, 2 months and 3 months', async () => {
    wrap(<ContractPlanDialog sale={SALE} onClose={vi.fn()} />);
    const dialog = screen.getByTestId('contract-plan-dialog');
    expect(within(dialog).getByRole('combobox').textContent).toContain('Week');
    fireEvent.click(within(dialog).getByRole('combobox'));
    const options = (await screen.findAllByRole('option')).map((o) => o.textContent);
    expect(options).toEqual(['Week', '2 weeks', 'Month', '2 months', '3 months']);
    expect(screen.getByTestId('contract-hint').textContent).toBe(
      'Change any date or amount below, or add and remove instalments.',
    );
  });

  it('a weekly plan dates untouched rows a week apart; a hand-typed date and amount stay put', async () => {
    await openMonthlyPlan(SALE, vi.fn());
    const first = firstDueField().value;
    const handDate = addMonths(businessToday(), 9);
    fireEvent.change(dateOf(1), { target: { value: handDate } });
    typeInto(amount(2), '1000');

    await pickInterval('Week');
    expect([0, 1, 2].map((i) => dateOf(i).value)).toEqual([first, handDate, stepDate(first, 'week', 2)]);
    expect(amount(2).value).toBe('1,000');

    await pickInterval('3 months');
    expect([0, 1, 2].map((i) => dateOf(i).value)).toEqual([first, handDate, stepDate(first, 'threeMonths', 2)]);
    expect(amount(2).value).toBe('1,000');
  });

  it('a typed amount is never overwritten by moving the first date, a second time or by the interval', async () => {
    await openMonthlyPlan(SALE, vi.fn());
    typeInto(amount(0), '12000');
    fireEvent.change(firstDueField(), { target: { value: addMonths(businessToday(), 2) } });
    fireEvent.change(firstDueField(), { target: { value: addMonths(businessToday(), 3) } });
    await pickInterval('2 weeks');
    expect(amount(0).value).toBe('12,000');
  });

  it('Add instalment appends a row one interval after the last, amount 0, raises the count and blocks Create', async () => {
    await openMonthlyPlan(SALE, vi.fn());
    const first = firstDueField().value;
    fireEvent.click(addBtn());
    expect(countField().value).toBe('4');
    expect(dateOf(3).value).toBe(addMonths(first, 3));
    expect(amount(3).value).toBe('0');
    expect(createBtn().disabled).toBe(true);
    expect(screen.getByTestId('contract-row-error').textContent).toBe('Every instalment needs an amount greater than 0.');
    expect(screen.getByTestId('contract-difference').textContent).toBe('Matches the remaining amount');
  });

  it('then Split remaining equally spreads the remaining amount over all the rows and allows Create', async () => {
    await openMonthlyPlan(SALE, vi.fn());
    fireEvent.click(addBtn());
    fireEvent.click(splitBtn());
    expect(shownAmounts()).toEqual(['6,300.00', '6,300.00', '6,300.00', '6,300.00']);
    expect(createBtn().disabled).toBe(false);
  });

  it('Split remaining equally puts the rounding on the last row and overwrites amounts only when asked', async () => {
    await openMonthlyPlan({ ...SALE, outstanding: '100.00', total: '100.00' }, vi.fn());
    typeInto(amount(0), '90');
    expect(amount(0).value).toBe('90');
    fireEvent.click(splitBtn());
    expect(shownAmounts()).toEqual(['33.33', '33.33', '33.34']);
    expect(createBtn().disabled).toBe(false);
  });

  it('after a hand-dated last row, the new row falls one interval after that date and keeps it', async () => {
    await openMonthlyPlan(SALE, vi.fn());
    fireEvent.change(dateOf(2), { target: { value: '2030-01-31' } });
    await pickInterval('2 weeks');
    fireEvent.click(addBtn());
    expect(dateOf(3).value).toBe('2030-02-14');
    fireEvent.change(firstDueField(), { target: { value: addMonths(businessToday(), 2) } });
    expect(dateOf(3).value).toBe('2030-02-14');
  });

  it('removing a middle row renumbers the rest, lowers the count and re-dates only untouched rows', async () => {
    await openMonthlyPlan(SALE, vi.fn());
    const first = firstDueField().value;
    typeInto(amount(2), '1234');
    fireEvent.click(removeBtn(1));

    expect(countField().value).toBe('2');
    expect(screen.queryByTestId('contract-amount-2')).toBeNull();
    expect(shownAmounts()).toEqual(['8,400.00', '1,234']);
    expect([0, 1].map((i) => dateOf(i).value)).toEqual([first, addMonths(first, 1)]);
    expect(removeBtn(1).getAttribute('aria-label')).toBe('Remove instalment 2');
    const numbers = within(screen.getByTestId('contract-rows')).getAllByText(/^\d+$/).map((el) => el.textContent);
    expect(numbers).toEqual(['1', '2']);
    expect(createBtn().disabled).toBe(true);
  });

  it('a removed hand-dated row takes its date with it; the row that moves up is dated by position', async () => {
    await openMonthlyPlan(SALE, vi.fn());
    const first = firstDueField().value;
    fireEvent.change(dateOf(1), { target: { value: '2030-06-01' } });
    fireEvent.click(removeBtn(1));
    expect(dateOf(1).value).toBe(addMonths(first, 1));
  });

  it('removing every row leaves no rows, the count at 0 with its reason, and Create disabled; Add starts again', async () => {
    await openMonthlyPlan(SALE, vi.fn());
    fireEvent.click(removeBtn(2));
    fireEvent.click(removeBtn(1));
    fireEvent.click(removeBtn(0));
    expect(countField().value).toBe('0');
    expect(screen.queryByTestId('contract-rows')).toBeNull();
    expect(screen.getByTestId('contract-count-error').textContent).toBe('Between 1 and 36 instalments');
    expect(createBtn().disabled).toBe(true);
    expect(splitBtn().disabled).toBe(true);

    fireEvent.click(addBtn());
    expect(countField().value).toBe('1');
    expect(dateOf(0).value).toBe(firstDueField().value);
    fireEvent.click(splitBtn());
    expect(shownAmounts()).toEqual(['25,200.00']);
    expect(createBtn().disabled).toBe(false);
  });

  it('no more than 36: Add is disabled at 36, and 37 typed is refused', async () => {
    await openMonthlyPlan(SALE, vi.fn());
    fireEvent.change(countField(), { target: { value: '36' } });
    expect(shownAmounts()).toHaveLength(36);
    expect(addBtn().disabled).toBe(true);
    fireEvent.click(addBtn());
    expect(shownAmounts()).toHaveLength(36);
    fireEvent.change(countField(), { target: { value: '37' } });
    expect(shownAmounts()).toHaveLength(0);
    expect(addBtn().disabled).toBe(true);
    expect(createBtn().disabled).toBe(true);
  });

  it('a new count after adding re-splits every row equally', async () => {
    await openMonthlyPlan(SALE, vi.fn());
    fireEvent.click(addBtn());
    typeInto(amount(0), '5');
    fireEvent.change(countField(), { target: { value: '2' } });
    expect(shownAmounts()).toEqual(['12,600.00', '12,600.00']);
    expect(createBtn().disabled).toBe(false);
  });

  it('typing 12 passes through 1 without losing the dates typed for later rows', async () => {
    await openMonthlyPlan(SALE, vi.fn());
    fireEvent.change(dateOf(2), { target: { value: '2030-03-03' } });
    fireEvent.change(countField(), { target: { value: '1' } });
    fireEvent.change(countField(), { target: { value: '12' } });
    expect(dateOf(2).value).toBe('2030-03-03');
    expect(shownAmounts()).toHaveLength(12);
  });

  it('an amount of 0 blocks Create with a reason; a minus sign cannot be typed', async () => {
    await openMonthlyPlan(SALE, vi.fn());
    typeInto(amount(0), '0');
    typeInto(amount(1), '16800');
    expect(screen.getByTestId('contract-difference').textContent).toBe('Matches the remaining amount');
    expect(createBtn().disabled).toBe(true);
    expect(screen.getByTestId('contract-row-error').textContent).toBe('Every instalment needs an amount greater than 0.');
    expect(amount(0).getAttribute('aria-invalid')).toBe('true');

    typeInto(amount(0), '-500');
    expect(amount(0).value).toBe('500');
  });

  it('a sum off by 0.01 either way keeps Create disabled', async () => {
    await openMonthlyPlan(SALE, vi.fn());
    typeInto(amount(2), '8400.01');
    expect(screen.getByTestId('contract-difference').textContent).toBe('0.01 EGP more than the remaining amount');
    expect(createBtn().disabled).toBe(true);
    typeInto(amount(2), '8399.99');
    expect(screen.getByTestId('contract-difference').textContent).toBe('0.01 EGP short of the remaining amount');
    expect(createBtn().disabled).toBe(true);
  });

  it("a row dated in the past says so in the server's words", async () => {
    await openMonthlyPlan(SALE, vi.fn());
    fireEvent.change(dateOf(1), { target: { value: '2020-01-01' } });
    expect(screen.getByTestId('contract-row-error').textContent).toBe('An instalment cannot fall due in the past (2020-01-01).');
    expect(createBtn().disabled).toBe(true);
  });

  it('rows out of date order are sent in date order; two on the same day are both sent', async () => {
    await openMonthlyPlan(SALE, vi.fn());
    const first = firstDueField().value;
    fireEvent.change(dateOf(0), { target: { value: '2030-05-05' } });
    fireEvent.change(dateOf(2), { target: { value: first } });
    fireEvent.change(dateOf(1), { target: { value: first } });
    typeInto(amount(0), '10000');
    typeInto(amount(2), '6800');
    fireEvent.click(createBtn());
    await waitFor(() => expect(state.posts).toHaveLength(1));
    expect(state.posts[0].body).toEqual({
      instalments: [
        { dueOn: first, amount: 8400 },
        { dueOn: first, amount: 6800 },
        { dueOn: '2030-05-05', amount: 10000 },
      ],
    });
  });

  it('a double click on Create sends one request, even before the button has re-rendered disabled', async () => {
    await openMonthlyPlan(SALE, vi.fn());
    const button = createBtn();
    // Both clicks inside one task: nothing has had a chance to repaint.
    act(() => {
      button.click();
      button.click();
    });
    await waitFor(() => expect(state.posts.length).toBeGreaterThan(0));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(state.posts).toHaveLength(1);
  });

  it('in Arabic: every label, the interval and the buttons are Arabic, the dialog laid out right to left', async () => {
    document.documentElement.dir = 'rtl';
    try {
      await openMonthlyPlan(SALE, vi.fn(), 'ar');
      const dialog = screen.getByTestId('contract-plan-dialog');
      expect(within(dialog).getByRole('combobox').textContent).toContain('شهر');
      expect(screen.getByTestId('contract-hint').textContent).toBe('غيّر أي تاريخ أو مبلغ في الجدول، أو أضف واحذف أقساطًا.');
      expect(addBtn().textContent).toBe('إضافة قسط');
      expect(splitBtn().textContent).toBe('قسّم المتبقي بالتساوي');
      expect(removeBtn(0).getAttribute('aria-label')).toBe('حذف القسط 1');
      expect(dialog.textContent).toContain('عدد الأقساط');
      expect(dialog.textContent).toContain('تاريخ أول قسط');
      expect(dialog.textContent).not.toMatch(/Every|Add instalment|Split remaining|Number of instalments/);
      fireEvent.click(addBtn());
      expect(screen.getByTestId('contract-row-error').textContent).toBe('كل قسط يحتاج مبلغًا أكبر من صفر.');
    } finally {
      document.documentElement.dir = '';
    }
  });
});
