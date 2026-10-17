import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/i18n/locales/en.json';
import { ToastProvider } from '@/components/ui/toast';
import PaymentsPage from './page';
import PaymentPlansRedirect from '../payment-plans/page';

/**
 * Payments and Contracts, two tabs of one page (owner, 2026-10-16; the second
 * was Instalment plans until 2026-10-17). The open tab is in the URL; the old
 * `?view=plans` and /payment-plans addresses land on Contracts.
 */

const nav = vi.hoisted(() => ({
  query: '',
  push: vi.fn(),
  replace: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useSearchParams: () => new URLSearchParams(nav.query),
  usePathname: () => '/en/payments',
  useRouter: () => ({ push: nav.push, replace: nav.replace }),
  useParams: () => ({ locale: 'en' }),
  redirect: nav.redirect,
}));
vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ user: { id: 'u-1', email: 'x@y.z', role: 'CORE_PARTNER' }, isLoading: false }),
}));
vi.mock('@/lib/api', () => ({
  api: {
    get: () => Promise.resolve({ data: { data: [], meta: { nextCursor: null } } }),
    post: vi.fn(),
  },
}));
// The contracts list is its own component with its own tests; here only which view shows.
vi.mock('@/components/payments/contracts-list', () => ({
  ContractsList: () => <div data-testid="contracts-view" />,
}));

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
});

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="Africa/Cairo">
      <QueryClientProvider client={client}>
        <ToastProvider>
          <PaymentsPage />
        </ToastProvider>
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  nav.query = '';
  nav.push.mockReset();
  nav.replace.mockReset();
  nav.redirect.mockReset();
});
afterEach(() => cleanup());

describe('the Payments page tabs', () => {
  it('opens on Payments, with the two tabs named Payments and Contracts', async () => {
    renderPage();
    const tabs = await screen.findAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Payments', 'Contracts']);
    expect(screen.getByTestId('tab-payments').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('heading', { level: 1, name: 'Payments' })).toBeTruthy();
    expect(screen.queryByTestId('contracts-view')).toBeNull();
  });

  it('the Contracts tab writes ?view=contracts without moving the page', async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId('tab-contracts'));
    expect(nav.push).toHaveBeenCalledWith('/en/payments?view=contracts', { scroll: false });
  });

  it('opened with ?view=contracts it shows the contracts, and Payments takes the parameter off again', async () => {
    nav.query = 'view=contracts';
    renderPage();
    expect(await screen.findByTestId('contracts-view')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Contracts' })).toBeTruthy();
    expect(screen.getByTestId('tab-contracts').getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByRole('heading', { level: 1, name: 'Payments' })).toBeNull();
    expect(nav.replace).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('tab-payments'));
    expect(nav.push).toHaveBeenCalledWith('/en/payments', { scroll: false });
  });

  it('the old ?view=plans opens Contracts and swaps the address for the new one, keeping the rest', async () => {
    nav.query = 'view=plans&x=1';
    renderPage();
    expect(await screen.findByTestId('contracts-view')).toBeTruthy();
    expect(screen.getByTestId('tab-contracts').getAttribute('aria-selected')).toBe('true');
    expect(nav.replace).toHaveBeenCalledWith('/en/payments?view=contracts&x=1', { scroll: false });
    expect(nav.push).not.toHaveBeenCalled();
  });

  it('an unknown view opens Payments', async () => {
    nav.query = 'view=nonsense';
    renderPage();
    expect(await screen.findByRole('heading', { level: 1, name: 'Payments' })).toBeTruthy();
    expect(screen.queryByTestId('contracts-view')).toBeNull();
  });

  it('the tab already open does nothing', async () => {
    nav.query = 'view=contracts';
    renderPage();
    fireEvent.click(await screen.findByTestId('tab-contracts'));
    expect(nav.push).not.toHaveBeenCalled();
  });
});

describe('/payment-plans', () => {
  it.each(['en', 'ar'])('redirects to the Contracts tab of Payments (%s)', async (locale) => {
    await PaymentPlansRedirect({ params: Promise.resolve({ locale }) });
    expect(nav.redirect).toHaveBeenCalledWith(`/${locale}/payments?view=contracts`);
  });
});
