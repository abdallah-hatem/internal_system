import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import en from '@/i18n/locales/en.json';
import ar from '@/i18n/locales/ar.json';

/**
 * The logo in the top bar on a phone (owner 2026-10-17: "on mobile we need the
 * logo here at navbar, not just the sidebar"). Below lg the sidebar is hidden,
 * so the bar carries the logo and the name, leading home; at lg and up the
 * sidebar shows it and the bar does not repeat it.
 */

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  usePathname: () => '/en/dashboard',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useParams: () => ({ locale: 'en' }),
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
  usePathname: () => '/dashboard',
}));
vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ user: { id: 'u-1', email: 'x@y.z', role: 'CORE_PARTNER' }, isLoading: false, logout: vi.fn() }),
}));
vi.mock('@/components/layout/notification-bell', () => ({ NotificationBell: () => null }));
vi.mock('@/components/layout/account-menu', () => ({ AccountMenu: () => null }));

import { AppShell } from './app-shell';

afterEach(cleanup);

function renderShell(locale: 'en' | 'ar' = 'en') {
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : ar} timeZone="Africa/Cairo">
      <AppShell>
        <p>page</p>
      </AppShell>
    </NextIntlClientProvider>,
  );
}

describe('the top bar carries the logo where the sidebar is hidden', () => {
  it('logo and name, in the header, leading to the dashboard', () => {
    renderShell();
    const brand = screen.getByTestId('topbar-brand');
    expect(brand.closest('header')).toBeTruthy();
    expect(brand.getAttribute('href')).toBe('/dashboard');
    expect(within(brand).getByRole('img', { name: 'S&F' })).toBeTruthy();
    expect(brand.textContent).toContain('S&F');
  });

  it('only below lg, where the sidebar is hidden — never two logos on a desktop', () => {
    renderShell();
    expect(screen.getByTestId('topbar-brand').className.split(/\s+/)).toContain('lg:hidden');
  });

  it('first in the bar, before the language switcher, in either direction', () => {
    for (const locale of ['en', 'ar'] as const) {
      renderShell(locale);
      const header = document.querySelector('header')!;
      const brand = within(header).getByTestId('topbar-brand');
      const lang = within(header).getByText(locale === 'ar' ? 'عربي' : 'EN');
      expect(brand.compareDocumentPosition(lang) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      cleanup();
    }
  });
});
