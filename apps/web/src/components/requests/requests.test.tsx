import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { Suspense, type ReactNode } from 'react';
import en from '@/i18n/locales/en.json';
import ar from '@/i18n/locales/ar.json';

/**
 * Requests (owner, 2026-10-17): order requests and import requests as two tabs
 * of one page, one menu entry instead of two — and the whole thing hidden in
 * production for now. The flag is switched per test here; its own rule
 * (production off, everywhere else on) is in lib/features.test.ts.
 */

const flags = vi.hoisted(() => ({ requests: true }));
vi.mock('@/lib/features', () => ({
  get REQUESTS_ENABLED() {
    return flags.requests;
  },
  get ENABLED_FEATURES() {
    return flags.requests ? ['requests'] : [];
  },
}));

const nav = vi.hoisted(() => ({
  query: '',
  pathname: '/en/requests',
  push: vi.fn(),
  replace: vi.fn(),
  redirect: vi.fn((to: string) => {
    // The real one throws to stop rendering; so must this, or a page that
    // forgot to return after redirecting would pass.
    throw new Error(`NEXT_REDIRECT ${to}`);
  }),
}));
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useSearchParams: () => new URLSearchParams(nav.query),
  usePathname: () => nav.pathname,
  useRouter: () => ({ push: nav.push, replace: nav.replace }),
  useParams: () => ({ locale: 'en' }),
  redirect: nav.redirect,
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
  // The shell's pathname is without the locale.
  usePathname: () => nav.pathname.replace(/^\/(en|ar)/, ''),
}));
vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({
    user: { id: 'u-1', email: 'x@y.z', role: 'CORE_PARTNER' },
    isLoading: false,
    logout: vi.fn(),
  }),
}));
// Each tab is the list it always was; here only which one shows.
vi.mock('./order-requests-list', () => ({
  OrderRequestsList: () => <div data-testid="orders-view" />,
}));
vi.mock('./import-requests-list', () => ({
  ImportRequestsList: () => <div data-testid="imports-view" />,
}));
// The shell's header widgets fetch on their own; the menu is what is tested.
vi.mock('@/components/layout/notification-bell', () => ({ NotificationBell: () => null }));
vi.mock('@/components/layout/account-menu', () => ({ AccountMenu: () => null }));
vi.mock('@/components/assistant/assistant-chat', () => ({ AssistantChat: () => null }));

import RequestsPage from '@/app/[locale]/requests/page';
import OrderRequestsRedirect from '@/app/[locale]/order-requests/page';
import ImportRequestsRedirect from '@/app/[locale]/import-requests/page';
import { RequestsViews } from './requests-views';
import { AppShell } from '@/components/layout/app-shell';

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
});

beforeEach(() => {
  flags.requests = true;
  nav.query = '';
  nav.pathname = '/en/requests';
  nav.push.mockClear();
  nav.redirect.mockClear();
});
afterEach(() => cleanup());

function withIntl(node: ReactNode, locale: 'en' | 'ar' = 'en') {
  return (
    <NextIntlClientProvider locale={locale} messages={locale === 'ar' ? ar : en} timeZone="Africa/Cairo">
      {node}
    </NextIntlClientProvider>
  );
}

/** Renders the route the way Next does: await the server component, then draw it. */
async function renderPage(locale: 'en' | 'ar' = 'en') {
  const page = await RequestsPage({ params: Promise.resolve({ locale }) });
  return render(withIntl(page, locale));
}

const redirectedTo = async (p: Promise<unknown>) => {
  await expect(p).rejects.toThrow(/NEXT_REDIRECT/);
  return nav.redirect.mock.calls.at(-1)?.[0];
};

// ─── The page ───────────────────────────────────────────────────────────

describe('the Requests page', () => {
  it('opens on Order requests, with the two tabs named after the pages they replace', async () => {
    await renderPage();
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Order requests', 'Import requests']);
    expect(screen.getByTestId('tab-orders').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('orders-view')).toBeTruthy();
    expect(screen.queryByTestId('imports-view')).toBeNull();
  });

  it('the Import requests tab writes ?view=imports without moving the page', async () => {
    await renderPage();
    fireEvent.click(screen.getByTestId('tab-imports'));
    expect(nav.push).toHaveBeenCalledWith('/en/requests?view=imports', { scroll: false });
  });

  it('opened with ?view=imports it shows import requests, and Order requests takes the parameter off', async () => {
    nav.query = 'view=imports';
    await renderPage();
    expect(screen.getByTestId('imports-view')).toBeTruthy();
    expect(screen.queryByTestId('orders-view')).toBeNull();
    expect(screen.getByTestId('tab-imports').getAttribute('aria-selected')).toBe('true');

    fireEvent.click(screen.getByTestId('tab-orders'));
    expect(nav.push).toHaveBeenCalledWith('/en/requests', { scroll: false });
  });

  it('switching tabs keeps the rest of the query, so nothing else on the page is lost', async () => {
    nav.query = 'view=imports&q=brake';
    await renderPage();
    fireEvent.click(screen.getByTestId('tab-orders'));
    expect(nav.push).toHaveBeenCalledWith('/en/requests?q=brake', { scroll: false });
  });

  it('the tab already open does nothing — a second click is not a second navigation', async () => {
    nav.query = 'view=imports';
    await renderPage();
    fireEvent.click(screen.getByTestId('tab-imports'));
    fireEvent.click(screen.getByTestId('tab-imports'));
    expect(nav.push).not.toHaveBeenCalled();
  });

  it('a view it does not know opens the first tab rather than an empty page', async () => {
    nav.query = 'view=plans';
    await renderPage();
    expect(screen.getByTestId('orders-view')).toBeTruthy();
  });

  it('switching tabs swaps the view inside the same page, the tab bar staying put', async () => {
    // The URL changes under a mounted page, as a client navigation does: the
    // same tree is drawn again (what the route renders), not a fresh page.
    const { rerender } = await renderPage();
    const bar = screen.getByRole('tablist');
    nav.query = 'view=imports';
    rerender(withIntl(<Suspense fallback={null}><RequestsViews /></Suspense>));
    expect(screen.getByRole('tablist')).toBe(bar);
    expect(screen.getByTestId('imports-view')).toBeTruthy();
  });

  it('renders in Arabic, right to left, with the tabs in Arabic', async () => {
    const page = await RequestsPage({ params: Promise.resolve({ locale: 'ar' }) });
    render(<div dir="rtl">{withIntl(page, 'ar')}</div>);
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual([ar.orderRequests.title, ar.importRequests.title]);
    expect(screen.getByRole('tablist').getAttribute('aria-label')).toBe(ar.requests.tabs.label);
    expect(screen.getByRole('tablist').closest('[dir]')?.getAttribute('dir')).toBe('rtl');
  });

  it.each(['en', 'ar'] as const)('switched off, /%s/requests goes to the dashboard', async (locale) => {
    flags.requests = false;
    expect(await redirectedTo(RequestsPage({ params: Promise.resolve({ locale }) }))).toBe(
      `/${locale}/dashboard`,
    );
  });
});

// ─── The old addresses ──────────────────────────────────────────────────

describe('the old list addresses', () => {
  it.each(['en', 'ar'])('/%s/order-requests lands on the Order requests tab', async (locale) => {
    expect(await redirectedTo(OrderRequestsRedirect({ params: Promise.resolve({ locale }) }))).toBe(
      `/${locale}/requests`,
    );
  });

  it.each(['en', 'ar'])('/%s/import-requests lands on the Import requests tab', async (locale) => {
    expect(await redirectedTo(ImportRequestsRedirect({ params: Promise.resolve({ locale }) }))).toBe(
      `/${locale}/requests?view=imports`,
    );
  });

  it('switched off, both go straight to the dashboard, not through /requests', async () => {
    flags.requests = false;
    expect(await redirectedTo(OrderRequestsRedirect({ params: Promise.resolve({ locale: 'en' }) }))).toBe(
      '/en/dashboard',
    );
    expect(await redirectedTo(ImportRequestsRedirect({ params: Promise.resolve({ locale: 'ar' }) }))).toBe(
      '/ar/dashboard',
    );
  });
});

// ─── The menu ───────────────────────────────────────────────────────────

describe('the office menu', () => {
  const renderShell = (locale: 'en' | 'ar' = 'en') =>
    render(withIntl(<AppShell><p>page</p></AppShell>, locale));
  const links = () => screen.getAllByRole('link').map((a) => a.getAttribute('href'));

  it('switched on, it has one Requests entry and neither of the two it replaced', () => {
    renderShell();
    const hrefs = links();
    expect(hrefs.filter((h) => h === '/requests')).toHaveLength(1);
    expect(hrefs.filter((h) => h?.includes('order-requests') || h?.includes('import-requests'))).toEqual([]);
    expect(screen.getByRole('link', { name: 'Requests' }).getAttribute('href')).toBe('/requests');
    expect(screen.queryByRole('link', { name: 'Order requests' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Import requests' })).toBeNull();
  });

  it('switched off, the menu offers no way to the requests at all', () => {
    flags.requests = false;
    renderShell();
    const hrefs = links();
    expect(hrefs.filter((h) => /requests/.test(h ?? ''))).toEqual([]);
    expect(screen.queryByRole('link', { name: 'Requests' })).toBeNull();
    // The rest of the menu is still there.
    expect(screen.getAllByRole('link', { name: 'Sales' }).length).toBeGreaterThan(0);
  });

  it('is lit on the Requests page, on either tab', () => {
    nav.pathname = '/en/requests';
    renderShell();
    expect(screen.getByRole('link', { name: 'Requests' }).getAttribute('aria-current')).toBe('page');
  });

  it('in Arabic the entry reads in Arabic, right to left, and does not clash with sales orders', () => {
    renderShell('ar');
    const entry = screen.getByRole('link', { name: ar.nav.requests });
    expect(entry.getAttribute('href')).toBe('/requests');
    expect(entry.closest('[dir]')?.getAttribute('dir')).toBe('rtl');
    expect(ar.nav.requests).not.toBe(ar.sales.title);
    expect(ar.nav.requests).not.toBe(ar.nav.sales);
    // The tab names differ from the menu entry, so a reader can tell the
    // page from its parts.
    const menu = within(entry.closest('nav')!);
    expect(menu.queryByRole('link', { name: ar.orderRequests.title })).toBeNull();
  });
});
