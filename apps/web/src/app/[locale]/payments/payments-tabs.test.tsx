import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/i18n/locales/en.json';
import { ToastProvider } from '@/components/ui/toast';
import PaymentsPage from './page';
import PaymentPlansRedirect from '../payment-plans/page';

/**
 * Payments and Instalment plans, two tabs of one page (owner, 2026-10-16). The
 * open tab is in the URL; the old /payment-plans address lands on it.
 */

const nav = vi.hoisted(() => ({
  query: '',
  push: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useSearchParams: () => new URLSearchParams(nav.query),
  usePathname: () => '/en/payments',
  useRouter: () => ({ push: nav.push, replace: vi.fn() }),
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
// The plans view is its own component with its own tests; here only which view shows.
vi.mock('@/components/payments/payment-plans-list', () => ({
  PaymentPlansList: () => <div data-testid="plans-view" />,
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
  nav.redirect.mockReset();
});
afterEach(() => cleanup());

describe('the Payments page tabs', () => {
  it('opens on Payments, with the two tabs named', async () => {
    renderPage();
    const tabs = await screen.findAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Payments', 'Instalment plans']);
    expect(screen.getByTestId('tab-payments').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('heading', { level: 1, name: 'Payments' })).toBeTruthy();
    expect(screen.queryByTestId('plans-view')).toBeNull();
  });

  it('the Instalment plans tab writes ?view=plans without moving the page', async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId('tab-plans'));
    expect(nav.push).toHaveBeenCalledWith('/en/payments?view=plans', { scroll: false });
  });

  it('opened with ?view=plans it shows the plans, and Payments takes the parameter off again', async () => {
    nav.query = 'view=plans';
    renderPage();
    expect(await screen.findByTestId('plans-view')).toBeTruthy();
    expect(screen.getByTestId('tab-plans').getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByRole('heading', { level: 1, name: 'Payments' })).toBeNull();

    fireEvent.click(screen.getByTestId('tab-payments'));
    expect(nav.push).toHaveBeenCalledWith('/en/payments', { scroll: false });
  });

  it('the tab already open does nothing', async () => {
    nav.query = 'view=plans';
    renderPage();
    fireEvent.click(await screen.findByTestId('tab-plans'));
    expect(nav.push).not.toHaveBeenCalled();
  });
});

describe('/payment-plans', () => {
  it.each(['en', 'ar'])('redirects to the plans tab of Payments (%s)', async (locale) => {
    await PaymentPlansRedirect({ params: Promise.resolve({ locale }) });
    expect(nav.redirect).toHaveBeenCalledWith(`/${locale}/payments?view=plans`);
  });
});
