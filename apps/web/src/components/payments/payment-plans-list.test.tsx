import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/i18n/locales/en.json';
import { ToastProvider } from '@/components/ui/toast';
import { PaymentPlansList, type Plan } from './payment-plans-list';

/**
 * Instalment plans, followed up (owner, 2026-10-16): no way to create one here
 * — a plan comes from a sale's Contract button — and a plan made that way names
 * its sale and opens its contract.
 */

const state = vi.hoisted(() => ({ plans: [] as unknown[] }));

vi.mock('@/lib/list-all', () => ({
  useAllRecords: () => ({ items: state.plans, capped: false, isLoading: false }),
}));
vi.mock('@/lib/api', () => ({ api: { post: vi.fn(), get: vi.fn() } }));
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/en/payments',
  useParams: () => ({ locale: 'en' }),
  useSearchParams: () => new URLSearchParams('view=plans'),
}));

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

function plan(id: string, saleOrder: Plan['saleOrder'], customer: string): Plan {
  return {
    id,
    reference: `PLAN-2026-000${id}`,
    status: 'ACTIVE',
    agreedOn: '2026-10-16',
    customer: { id: `c-${id}`, displayName: customer },
    saleOrder,
    instalments: [
      { id: `${id}-1`, sequence: 1, dueOn: '2026-11-16', amount: '8400.00', paidEgp: '0', outstandingEgp: '8400.00', state: 'UPCOMING' },
    ],
    totalEgp: '25200.00',
    paidEgp: '0.00',
    remainingEgp: '25200.00',
    overdueEgp: '0.00',
    isOverdue: false,
    nextDueOn: '2026-11-16',
    nextDueEgp: '8400.00',
  };
}

function renderList() {
  const client = new QueryClient();
  return render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="Africa/Cairo">
      <QueryClientProvider client={client}>
        <ToastProvider>
          <PaymentPlansList />
        </ToastProvider>
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  state.plans = [
    plan('1', { id: 'sale-1', orderNo: 'ORD-2026-00001' }, 'Al Nour Motors'),
    plan('2', null, 'Delta Spares'),
  ];
});
afterEach(() => cleanup());

const card = (customer: string) =>
  screen.getAllByTestId('payment-plan').find((c) => c.textContent?.includes(customer))!;

describe('the instalment plans list', () => {
  it('offers no way to create a plan', () => {
    renderList();
    expect(screen.queryByRole('button', { name: /new plan|create|agree/i })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(en.paymentPlans).not.toHaveProperty('create');
  });

  it("a plan linked to a sale shows the sale's order number and, opened, a link to its contract", () => {
    renderList();
    const linked = card('Al Nour Motors');
    expect(within(linked).getByTestId('plan-sale').textContent).toBe('Sale ORD-2026-00001');
    fireEvent.click(within(linked).getAllByRole('button')[0]);
    const link = within(linked).getByTestId('plan-open-contract');
    expect(link.getAttribute('href')).toBe('/en/sales/sale-1/contract');
    expect(link.textContent).toContain('Open contract');
  });

  it('a plan with no sale (an older one) shows neither', () => {
    renderList();
    const older = card('Delta Spares');
    expect(within(older).queryByTestId('plan-sale')).toBeNull();
    fireEvent.click(within(older).getAllByRole('button')[0]);
    expect(within(older).queryByTestId('plan-open-contract')).toBeNull();
    // Following up still works on it: cancel is there.
    expect(within(older).getByRole('button', { name: /cancel plan/i })).toBeTruthy();
  });

  it("with no plans, says they come from a sale's Contract button", () => {
    state.plans = [];
    renderList();
    expect(document.body.textContent).toContain("Plans are created from a sale's Contract button");
    expect(screen.getByRole('link', { name: 'Go to Sales' })).toBeTruthy();
  });
});
