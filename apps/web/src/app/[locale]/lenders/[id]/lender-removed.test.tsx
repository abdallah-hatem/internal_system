import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/i18n/locales/en.json';
import { ToastProvider } from '@/components/ui/toast';

/**
 * A friend's page shows the payments that stand; a removed one is history,
 * hidden until asked for (owner, 2026-10-16: "why in Mohammed's profile I see
 * the removed payment?").
 */

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'l-mohammed', locale: 'en' }),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ user: { id: 'u', email: 'p@x.z', role: 'CORE_PARTNER' }, isLoading: false }),
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
  useRouter: () => ({ push: vi.fn() }),
}));

const financing = (id: string, reference: string, amount: string, removedAt: string | null) => ({
  id,
  lender: { id: 'l-mohammed', name: 'Mohammed' },
  purchaseOrder: { id: 'po', reference },
  cycle: { id: 'c', code: 'CYC-2026-0001', status: 'PLANNING' },
  currency: 'AED',
  amount,
  fxRateToEgp: '13.85',
  amountEgp: '0',
  paidOn: '2026-07-15',
  removedAt,
  repaid: '0',
  owed: removedAt ? '0' : amount,
  paidEgp: '0',
  exchangeDiffEgp: '0',
  repayments: [],
  plan: null,
});

let financings = [financing('f-new', 'PO-2026-0001', '8302.60', null)];
vi.mock('@/lib/api', () => ({
  api: {
    get: () =>
      Promise.resolve({
        data: { data: { id: 'l-mohammed', name: 'Mohammed', phone: null, notes: null, owed: [{ currency: 'AED', owed: '8302.60' }], financings } },
      }),
    post: vi.fn(),
  },
}));

import LenderPage from './page';

function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale="en" messages={en} timeZone="Africa/Cairo">
        <ToastProvider>
          <LenderPage />
        </ToastProvider>
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

describe("a friend's page and a removed payment", () => {
  it('shows the payment that stands and hides the removed one until asked', async () => {
    financings = [
      financing('f-new', 'PO-2026-0001', '8302.60', null),
      financing('f-old', 'PO-2026-0001', '6509.86', '2026-10-16T15:00:09.019Z'),
    ];
    show();
    expect((await screen.findAllByText(/8,302\.60/)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/6,509\.86/)).toBeNull();
    expect(screen.queryByText(en.lenders.removed)).toBeNull();

    const toggle = screen.getByTestId('toggle-removed');
    expect(toggle.textContent).toBe('Show the removed payment');
    fireEvent.click(toggle);
    expect(screen.getAllByText(/6,509\.86/).length).toBeGreaterThan(0);
    expect(screen.getByText(en.lenders.removed)).toBeTruthy();
    expect(toggle.textContent).toBe(en.lenders.hideRemoved);

    fireEvent.click(toggle);
    expect(screen.queryByText(/6,509\.86/)).toBeNull();
  });

  it('no switch when nothing was removed', async () => {
    financings = [financing('f-new', 'PO-2026-0001', '8302.60', null)];
    show();
    expect((await screen.findAllByText(/8,302\.60/)).length).toBeGreaterThan(0);
    expect(screen.queryByTestId('toggle-removed')).toBeNull();
  });
});
