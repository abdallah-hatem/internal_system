import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/i18n/locales/en.json';
import ar from '@/i18n/locales/ar.json';

/**
 * A shop's orders and payments on its own page (owner 2026-10-17: on a phone
 * "this cards layout is weird" — five values folded into a two-column grid
 * left Outstanding alone in the middle of its row). Desktop: the shared table.
 * Phone: a card per order — number and status, date and total, then what is
 * owed on its own labelled line; a card per payment the same way.
 */

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useParams: () => ({ id: 'cust-1', locale: 'en' }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/en/customers/cust-1',
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ user: { id: 'u-1', email: 'x@y.z', role: 'CORE_PARTNER' }, isLoading: false }),
}));
vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string) =>
      Promise.resolve({
        data: { data: url === '/customers/cust-1' ? { id: 'cust-1', displayName: 'Koshary', type: 'B2B', currency: 'EGP' } : [] },
      }),
  },
}));
const lists = vi.hoisted(() => ({ loading: false, orders: [] as unknown[], payments: [] as unknown[] }));
vi.mock('@/lib/list-all', () => ({
  useAllRecords: (_key: unknown, path: string) => ({
    items: path === '/sales/orders' ? lists.orders : path === '/payments' ? lists.payments : [],
    capped: false,
    isLoading: lists.loading,
  }),
}));
vi.mock('@/components/customers/customer-statement', () => ({ CustomerStatement: () => null }));
vi.mock('@/components/payments/contracts-list', () => ({ ContractsList: () => null }));

import CustomerPage from './page';

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(() => {
  cleanup();
  lists.loading = false;
  lists.orders = [];
  lists.payments = [];
});

function renderPage(locale: 'en' | 'ar' = 'en') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : ar} timeZone="Africa/Cairo">
      <QueryClientProvider client={client}>
        <CustomerPage />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

const ORDER = {
  id: 'o-5', orderNo: 'ORD-2026-00005', status: 'CONFIRMED', total: '3300', outstanding: '3300',
  currency: 'EGP', orderedAt: '2026-10-16T09:00:00Z', createdAt: '2026-10-16T09:00:00Z',
};

describe('an order on a phone is a card that reads in pairs', () => {
  it('number and status, then date and total, then what is owed on its own labelled line', async () => {
    lists.orders = [ORDER];
    renderPage();
    const card = await screen.findByTestId('customer-order-card');
    const [top, mid, bottom] = Array.from(card.children) as HTMLElement[];
    expect(top.textContent).toContain('ORD-2026-00005');
    expect(top.textContent).toContain(en.codes.orderStatus.CONFIRMED);
    expect(mid.textContent).toContain('Oct 16, 2026');
    expect(mid.textContent).toContain('3,300.00');
    expect(bottom.textContent).toContain(en.sales.outstanding);
    expect(bottom.textContent).toContain('3,300.00');
    // Each line is a start/end pair — nothing left alone in a grid cell.
    for (const row of [top, mid, bottom]) {
      expect(row.className).toContain('justify-between');
      expect(row.children).toHaveLength(2);
    }
    expect(card.closest('ul')!.className).toContain('md:hidden');
  });

  it('owed money is red, paid-up is green, a draft owes nothing and says why', async () => {
    lists.orders = [
      ORDER,
      { ...ORDER, id: 'o-6', orderNo: 'ORD-2026-00006', outstanding: '0' },
      { ...ORDER, id: 'o-7', orderNo: 'ORD-2026-00007', status: 'DRAFT' },
    ];
    renderPage();
    const [owed, paid, draft] = await screen.findAllByTestId('customer-order-card');
    expect(within(owed).getByTestId('outstanding').className).toContain('text-destructive');
    expect(within(paid).getByTestId('outstanding').className).toContain('text-success');
    expect(draft.textContent).toContain(en.sales.notConfirmed);
  });

  it('the desktop table is the shared one, with all five columns', async () => {
    lists.orders = [ORDER];
    renderPage();
    const row = await screen.findByTestId('customer-order-row');
    expect(row.closest('table')).toBeTruthy();
    const headers = Array.from(row.closest('table')!.querySelectorAll('th')).map((th) => th.textContent);
    expect(headers).toEqual([en.sales.orderNo, en.sales.date, en.common.status, en.sales.total, en.sales.outstanding]);
  });
});

describe('a payment on a phone reads the same way', () => {
  it('method and amount, then date and status; unapplied money only when there is some', async () => {
    lists.payments = [
      { id: 'p-1', amount: '5000', currency: 'EGP', method: 'CASH', status: 'RECORDED', receivedOn: '2026-10-17', allocations: [{ amount: '3000' }] },
      { id: 'p-2', amount: '1000', currency: 'EGP', method: 'BANK_TRANSFER', status: 'RECORDED', receivedOn: '2026-10-15', allocations: [{ amount: '1000' }] },
    ];
    renderPage();
    const [credit, applied] = await screen.findAllByTestId('customer-payment-card');
    const [top, mid, bottom] = Array.from(credit.children) as HTMLElement[];
    expect(top.textContent).toContain(en.codes.paymentMethod.CASH);
    expect(top.textContent).toContain('5,000.00');
    expect(mid.textContent).toContain(en.codes.paymentStatus.RECORDED);
    expect(bottom.textContent).toContain(en.customers.unappliedColumn);
    expect(bottom.textContent).toContain('2,000.00');
    expect(applied.children).toHaveLength(2);
  });
});

describe('while the lists load', () => {
  it('phone cards and the table both show skeletons, never "no orders yet"', async () => {
    lists.loading = true;
    renderPage();
    await screen.findAllByTestId('skeleton-row');
    expect(screen.queryByText(en.customers.noOrders)).toBeNull();
    expect(screen.queryByTestId('customer-order-card')).toBeNull();
  });
});

describe('in Arabic', () => {
  it('the card reads with Arabic labels', async () => {
    lists.orders = [ORDER];
    renderPage('ar');
    const card = await screen.findByTestId('customer-order-card');
    expect(card.textContent).toContain(ar.sales.outstanding);
    expect(card.textContent).toContain(ar.codes.orderStatus.CONFIRMED);
  });
});
