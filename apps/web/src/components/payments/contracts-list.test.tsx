import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AnchorHTMLAttributes } from 'react';
import en from '@/i18n/locales/en.json';
import ar from '@/i18n/locales/ar.json';
import { ToastProvider } from '@/components/ui/toast';
import { ContractsList, contractStanding, type Plan } from './contracts-list';

/**
 * Contracts replace payment plans (owner, 2026-10-17): one row per contract,
 * opening that contract; the same list on a shop's page, narrowed to the shop.
 */

const state = vi.hoisted(() => ({
  plans: [] as unknown[],
  isLoading: false,
  isError: false,
  error: null as unknown,
  calls: [] as { key: unknown; path: string; params: unknown }[],
  push: vi.fn(),
}));

vi.mock('@/lib/list-all', () => ({
  useAllRecords: (key: unknown, path: string, params: unknown) => {
    state.calls.push({ key, path, params });
    return {
      items: state.isLoading || state.isError ? [] : state.plans,
      capped: false,
      isLoading: state.isLoading,
      isError: state.isError,
      error: state.error,
    };
  },
}));
vi.mock('@/lib/api', () => ({ api: { post: vi.fn(), get: vi.fn() } }));
// next-intl's locale-aware navigation: the href it renders carries the locale.
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={`/en${href}`} {...rest} />
  ),
  useRouter: () => ({ push: state.push, replace: vi.fn() }),
}));
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/en/payments',
  useParams: () => ({ locale: 'en' }),
  useSearchParams: () => new URLSearchParams('view=contracts'),
}));

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

function plan(
  id: string,
  customer: string,
  saleOrder: Plan['saleOrder'],
  over: Partial<Plan> = {},
): Plan {
  return {
    id,
    reference: `PLAN-2026-000${id}`,
    status: 'ACTIVE',
    agreedOn: '2026-10-16',
    customer: { id: `c-${customer}`, displayName: customer },
    saleOrder,
    instalments: [],
    totalEgp: '25200.00',
    paidEgp: '8400.00',
    remainingEgp: '16800.00',
    overdueEgp: '0.00',
    isOverdue: false,
    nextDueOn: '2026-11-21',
    nextDueEgp: '8400.00',
    ...over,
  };
}

const NOUR = plan('1', 'Al Nour Motors', { id: 'sale-1', orderNo: 'ORD-2026-00001' });
const DELTA_OVERDUE = plan('2', 'Delta Spares', { id: 'sale-2', orderNo: 'ORD-2026-00002' }, {
  isOverdue: true, overdueEgp: '3000.00', paidEgp: '5400.00', remainingEgp: '19800.00',
});
const NOUR_PAID = plan('3', 'Al Nour Motors', { id: 'sale-3', orderNo: 'ORD-2026-00003' }, {
  status: 'COMPLETED', paidEgp: '25200.00', remainingEgp: '0.00', nextDueOn: null, nextDueEgp: null,
});
const OLD_UNLINKED = plan('4', 'Cairo Bikes', null);

function renderList(props: { customerId?: string } = {}, locale: 'en' | 'ar' = 'en') {
  const client = new QueryClient();
  return render(
    <div dir={locale === 'ar' ? 'rtl' : 'ltr'}>
      <NextIntlClientProvider locale={locale} messages={locale === 'ar' ? ar : en} timeZone="Africa/Cairo">
        <QueryClientProvider client={client}>
          <ToastProvider>
            <ContractsList {...props} />
          </ToastProvider>
        </QueryClientProvider>
      </NextIntlClientProvider>
    </div>,
  );
}

beforeEach(() => {
  state.plans = [NOUR, DELTA_OVERDUE, NOUR_PAID, OLD_UNLINKED];
  state.isLoading = false;
  state.isError = false;
  state.error = null;
  state.calls = [];
  state.push.mockReset();
});
afterEach(() => cleanup());

const rows = () => screen.getAllByTestId('contract-row');
const rowOf = (orderOrShop: string) => rows().find((r) => r.textContent?.includes(orderOrShop))!;

describe('the Contracts list (every shop)', () => {
  it('one row per contract: shop, order number, total, paid, next due date and amount', () => {
    renderList();
    expect(rows()).toHaveLength(4);
    const row = rowOf('ORD-2026-00001');
    const text = row.textContent!;
    expect(text).toContain('Al Nour Motors');
    expect(text).toContain('25,200.00');
    expect(text).toContain('8,400.00');
    expect(text).toMatch(/21.*Nov|Nov.*21|21\/11\/2026/);
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(
      expect.arrayContaining(['Shop', 'Contract', 'Contract total', 'Paid', 'Next due']),
    );
  });

  it('a row opens its own contract — the sale it was signed for, not another', () => {
    renderList();
    fireEvent.click(rowOf('ORD-2026-00002'));
    expect(state.push).toHaveBeenCalledTimes(1);
    expect(state.push).toHaveBeenCalledWith('/sales/sale-2/contract');
    // and by keyboard: the order number is a real link to the same page.
    const link = within(rowOf('ORD-2026-00001')).getByTestId('contract-open');
    expect(link.getAttribute('href')).toBe('/en/sales/sale-1/contract');
  });

  it('whoever is behind comes first, marked Overdue with how much', () => {
    renderList();
    expect(rows()[0].textContent).toContain('Delta Spares');
    const row = rowOf('Delta Spares');
    expect(row.getAttribute('data-standing')).toBe('overdue');
    expect(row.textContent).toContain('Overdue');
    expect(row.textContent).toContain('3,000.00');
    expect(screen.getByText(/Behind across all contracts/)).toBeTruthy();
  });

  it('a contract paid in full says All paid, not a next due date', () => {
    renderList();
    const row = rowOf('ORD-2026-00003');
    expect(row.getAttribute('data-standing')).toBe('paid');
    expect(row.textContent).toContain('All paid');
    expect(row.textContent).not.toContain('Overdue');
  });

  it('an older plan with no sale is still listed — it is money owed — and says it has no contract', () => {
    renderList();
    const row = rowOf('Cairo Bikes');
    expect(within(row).getByTestId('contract-none').textContent).toBe('No contract (older plan)');
    expect(within(row).queryByTestId('contract-open')).toBeNull();
    fireEvent.click(row);
    expect(state.push).not.toHaveBeenCalled();
  });

  it('cancelling a plan from its row does not open the contract', () => {
    vi.spyOn(window, 'prompt').mockReturnValue(null);
    renderList();
    fireEvent.click(within(rowOf('ORD-2026-00001')).getByRole('button', { name: 'Cancel the instalment plan' }));
    expect(window.prompt).toHaveBeenCalled();
    expect(state.push).not.toHaveBeenCalled();
    // A completed plan has nothing to cancel.
    expect(within(rowOf('ORD-2026-00003')).queryByRole('button', { name: 'Cancel the instalment plan' })).toBeNull();
  });

  it('with no contracts, says where one comes from and offers no way to make one here', () => {
    state.plans = [];
    renderList();
    expect(screen.getByTestId('contracts-empty').textContent).toContain('No contracts yet');
    expect(screen.getByRole('link', { name: 'Go to Sales' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /new|create|agree/i })).toBeNull();
  });

  it('while loading shows skeleton rows, not the empty state', () => {
    state.isLoading = true;
    renderList();
    expect(screen.getAllByTestId('skeleton-row').length).toBeGreaterThan(0);
    expect(screen.queryByTestId('contracts-empty')).toBeNull();
    expect(screen.queryByTestId('contract-row')).toBeNull();
  });

  it("an API refusal is said in words, from its code — not a blank list", () => {
    state.isError = true;
    state.error = {
      response: { data: { error: { code: 'ROLE_NOT_ALLOWED', message: 'Role INVESTOR may not read this.' } } },
    };
    renderList();
    expect(screen.getByRole('alert').textContent).toBe('Your role does not allow this action.');
    expect(screen.queryByTestId('contracts-empty')).toBeNull();
  });
});

describe("a shop's contracts", () => {
  it('asks the API for this shop only, and shows no shop column', () => {
    state.plans = [NOUR, NOUR_PAID];
    renderList({ customerId: 'c-Al Nour Motors' });
    expect(state.calls[0]).toEqual({
      key: ['paymentPlans', 'c-Al Nour Motors'],
      path: '/payment-plans',
      params: { customerId: 'c-Al Nour Motors' },
    });
    expect(rows()).toHaveLength(2);
    expect(screen.queryByRole('columnheader', { name: 'Shop' })).toBeNull();
  });

  it("never shows another shop's contract, whatever reached it", () => {
    // Everyone's list, as if the cache held the unfiltered one.
    renderList({ customerId: 'c-Al Nour Motors' });
    const shown = rows().map((r) => r.textContent);
    expect(shown).toHaveLength(2);
    expect(shown.join(' ')).not.toContain('ORD-2026-00002');
    expect(shown.join(' ')).not.toContain('Cairo Bikes');
  });

  it('opens the shop\'s contract from its row', () => {
    renderList({ customerId: 'c-Al Nour Motors' });
    fireEvent.click(rowOf('ORD-2026-00001'));
    expect(state.push).toHaveBeenCalledWith('/sales/sale-1/contract');
  });

  it('a shop with no contracts says so — nothing invented', () => {
    state.plans = [DELTA_OVERDUE];
    renderList({ customerId: 'c-Al Nour Motors' });
    expect(screen.getByTestId('contracts-empty').textContent).toContain('No contracts for this shop');
    expect(screen.queryByTestId('contract-row')).toBeNull();
    expect(screen.queryByTestId('contract-card')).toBeNull();
  });
});

describe('in Arabic, right to left', () => {
  it('headers, states and the no-contract label are Arabic; order numbers stay left to right', () => {
    renderList({}, 'ar');
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(
      expect.arrayContaining(['المحل', 'العقد', 'إجمالي العقد', 'المدفوع', 'الاستحقاق القادم']),
    );
    expect(rowOf('ORD-2026-00003').textContent).toContain('مدفوع بالكامل');
    expect(rowOf('Delta Spares').textContent).toContain('متأخر');
    expect(within(rowOf('Cairo Bikes')).getByTestId('contract-none').textContent).toBe('بلا عقد (خطة قديمة)');
    const order = within(rowOf('ORD-2026-00001')).getByTestId('contract-open').querySelector('bdi')!;
    expect(order.getAttribute('dir')).toBe('ltr');
  });
});

describe('contractStanding', () => {
  it.each([
    [{ isOverdue: true, remainingEgp: '100' }, 'overdue'],
    [{ isOverdue: false, remainingEgp: '0.00' }, 'paid'],
    [{ isOverdue: false, remainingEgp: '-5' }, 'paid'],
    [{ isOverdue: false, remainingEgp: '0.01' }, 'open'],
  ] as const)('%o → %s', (p, expected) => {
    expect(contractStanding(p)).toBe(expected);
  });
});
