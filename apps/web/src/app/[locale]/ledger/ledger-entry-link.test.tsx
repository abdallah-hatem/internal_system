import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/i18n/locales/en.json';
import { ToastProvider } from '@/components/ui/toast';

/**
 * `/ledger?entry=<id>` — where an expense row of Analytics' "what made this
 * bar" links (2026-10-28) — opens that entry, fetched on its own (it need not
 * be on the page showing), and closing it forgets the link, keeping the rest
 * of the address.
 */

const nav = vi.hoisted(() => ({ query: 'entry=e-fuel&page=2', replace: vi.fn() }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(nav.query),
  usePathname: () => '/en/ledger',
  useRouter: () => ({ push: vi.fn(), replace: nav.replace }),
  useParams: () => ({ locale: 'en' }),
}));
vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ user: { id: 'u', email: 'p@x.z', role: 'CORE_PARTNER' }, isLoading: false }),
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/ledger',
}));

const get = vi.fn();
const ENTRY = {
  id: 'e-fuel',
  type: 'EXPENSE',
  category: 'fuel',
  direction: 'OUTFLOW',
  amount: '500.00',
  currency: 'EGP',
  occurredOn: '2026-10-08',
  createdAt: '2026-10-08T10:00:00Z',
  reason: 'Delivery to Mokattam',
  cycle: { id: 'c', code: 'CYC-2026-0002' },
  paidBy: { id: 'u-shady', partner: { displayName: 'Shady' } },
};
vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string, opts?: unknown) => {
      get(url, opts);
      if (url === '/ledger/e-fuel') return Promise.resolve({ data: { data: ENTRY } });
      if (url === '/ledger') return Promise.resolve({ data: { data: [], meta: { page: 1, pageSize: 10, total: 0, totalPages: 0 } } });
      return Promise.resolve({ data: { data: [] } });
    },
    post: vi.fn(),
  },
}));

import LedgerPage from './page';

function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale="en" messages={en} timeZone="Africa/Cairo">
        <ToastProvider>
          <LedgerPage />
        </ToastProvider>
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  nav.query = 'entry=e-fuel&page=2';
  nav.replace.mockReset();
  get.mockReset();
});
afterEach(cleanup);

describe('the ledger opens the entry a link names', () => {
  it('fetches it on its own and opens it, Paid by shown; closing forgets the link and keeps the page', async () => {
    show();
    const dialog = await screen.findByRole('dialog');
    expect(get).toHaveBeenCalledWith('/ledger/e-fuel', undefined);
    expect(dialog.textContent).toContain('CYC-2026-0002');
    expect(dialog.textContent).toContain('Shady');
    fireEvent.click(within(dialog).getByRole('button', { name: en.common.close }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(nav.replace).toHaveBeenCalledWith('/en/ledger?page=2', { scroll: false });
  });

  it('with no link, nothing opens by itself', async () => {
    nav.query = '';
    show();
    await screen.findAllByText(en.ledger.emptyTitle);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(get).not.toHaveBeenCalledWith('/ledger/e-fuel', undefined);
  });
});
