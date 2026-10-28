import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/i18n/locales/en.json';
import { ToastProvider } from '@/components/ui/toast';

/**
 * Sales opens on the orders still being paid for (owner 2026-10-28: "make the
 * default filter confirmed and partially paid"): with no `?status=` the list and
 * its cards ask for Confirmed + Partially paid; a status in the link, or All, is
 * respected — on the second visit too, because it is in the address.
 */

const nav = vi.hoisted(() => ({ query: '', replace: vi.fn() }));
vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ user: { id: 'u-1', email: 'p@x.z', role: 'CORE_PARTNER' }, isLoading: false }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: nav.replace }),
  useSearchParams: () => new URLSearchParams(nav.query),
  useParams: () => ({ locale: 'en' }),
  usePathname: () => '/en/sales',
}));
vi.mock('@/i18n/navigation', () => ({ Link: ({ children }: { children: unknown }) => children }));

const calls = vi.hoisted(() => ({ get: [] as { url: string; params?: Record<string, unknown> }[] }));
vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string, opts?: { params?: Record<string, unknown> }) => {
      calls.get.push({ url, params: opts?.params });
      return Promise.resolve({
        data: { data: [], meta: { nextCursor: null, page: 1, pageSize: 10, total: 0, totalPages: 0 } },
      });
    },
    post: () => new Promise(() => {}),
  },
}));

import SalesPage from '@/app/[locale]/sales/page';

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
});

beforeEach(() => {
  nav.query = '';
  nav.replace.mockReset();
  calls.get = [];
});
afterEach(cleanup);

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="Africa/Cairo">
      <QueryClientProvider client={client}>
        <ToastProvider>
          <SalesPage />
        </ToastProvider>
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

const asked = (url: string) => calls.get.filter((c) => c.url === url).map((c) => c.params?.status ?? '');
const pill = (label: string) =>
  screen.getByTestId('sales-status-filter').querySelector<HTMLElement>(`[aria-pressed][data-value="${label}"]`)!;

describe('Sales opens on Confirmed + Partially paid', () => {
  it('with no status in the address, the list and its cards ask for both, and the pill says so', async () => {
    renderPage();
    await waitFor(() => expect(asked('/sales/orders')).toContain('CONFIRMED,PARTIALLY_PAID'));
    expect(asked('/analytics/top-orders')).toContain('CONFIRMED,PARTIALLY_PAID');
    expect(pill('owing').getAttribute('aria-pressed')).toBe('true');
    expect(pill('owing').textContent).toBe(en.sales.owing);
    expect(pill('all').getAttribute('aria-pressed')).toBe('false');
  });

  it('All writes ?status=ALL, so clearing it holds on the second visit; the default writes nothing', () => {
    renderPage();
    fireEvent.click(pill('all'));
    expect(String(nav.replace.mock.calls.at(-1)?.[0])).toContain('status=ALL');
    nav.replace.mockReset();
    fireEvent.click(pill('owing'));
    expect(String(nav.replace.mock.calls.at(-1)?.[0] ?? '')).not.toContain('status=');
  });

  it('on ?status=ALL every order is asked for: no status sent, All chosen', async () => {
    nav.query = 'status=ALL';
    renderPage();
    await waitFor(() => expect(asked('/sales/orders').length).toBeGreaterThan(0));
    expect(asked('/sales/orders')).toEqual(asked('/sales/orders').map(() => ''));
    expect(pill('all').getAttribute('aria-pressed')).toBe('true');
  });

  it('a link with its own status keeps it, for the list and the cards', async () => {
    nav.query = 'status=PAID';
    renderPage();
    await waitFor(() => expect(asked('/sales/orders')).toContain('PAID'));
    expect(asked('/sales/orders')).not.toContain('CONFIRMED,PARTIALLY_PAID');
    expect(asked('/analytics/top-orders')).toContain('PAID');
    expect(pill('paid').getAttribute('aria-pressed')).toBe('true');
  });
});
