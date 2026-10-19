import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/locales/en.json';
import ar from '@/i18n/locales/ar.json';
import { AccountMenu } from './account-menu';

const auth = vi.hoisted(() => ({
  logout: vi.fn(() => Promise.resolve()),
  user: {
    id: 'u1',
    email: 'abdallah@motoparts.com',
    role: 'CORE_PARTNER',
    // The shape POST /auth/login stores: the name flat on the user.
    displayName: 'Partner A',
  } as { id: string; email: string; role: string; displayName?: string } | null,
}));

vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ user: auth.user, logout: auth.logout }),
}));

beforeEach(() => auth.logout.mockClear());
afterEach(cleanup);

function renderIt(locale: 'en' | 'ar' = 'en') {
  render(
    <NextIntlClientProvider locale={locale} messages={locale === 'ar' ? ar : en} timeZone="Africa/Cairo">
      <AccountMenu />
    </NextIntlClientProvider>,
  );
}

const trigger = () => screen.getByRole('button', { name: /account menu/i });

describe('AccountMenu', () => {
  it('is a real button with an explicit type, showing who is signed in', () => {
    renderIt();
    expect(trigger().getAttribute('type')).toBe('button');
    expect(trigger().textContent).toContain('Partner A');
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
  });

  it('opens on click to show name, email, role and Log out — and nothing is signed out yet', () => {
    renderIt();
    fireEvent.click(trigger());
    const menu = screen.getByTestId('account-menu');
    expect(menu.textContent).toContain('Partner A');
    expect(menu.textContent).toContain('abdallah@motoparts.com');
    expect(menu.textContent).toMatch(/core partner/i);
    expect(screen.getByRole('button', { name: 'Log out' }).getAttribute('type')).toBe('button');
    expect(auth.logout).not.toHaveBeenCalled();
  });

  it('Log out calls logout() once', () => {
    renderIt();
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole('button', { name: 'Log out' }));
    expect(auth.logout).toHaveBeenCalledTimes(1);
  });

  it('a second click while signing out does not call logout() again', () => {
    renderIt();
    fireEvent.click(trigger());
    const button = screen.getByRole('button', { name: 'Log out' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(auth.logout).toHaveBeenCalledTimes(1);
  });

  it('Escape closes it without signing out', () => {
    renderIt();
    fireEvent.click(trigger());
    expect(screen.queryByTestId('account-menu')).not.toBeNull();
    fireEvent.keyDown(screen.getByTestId('account-menu'), { key: 'Escape' });
    expect(screen.queryByTestId('account-menu')).toBeNull();
    expect(auth.logout).not.toHaveBeenCalled();
  });

  it('speaks Arabic in an Arabic session', () => {
    renderIt('ar');
    fireEvent.click(screen.getByRole('button', { name: ar.nav.accountMenu }));
    expect(screen.getByRole('button', { name: ar.nav.logout })).toBeTruthy();
  });

  it('a user with no partner name falls back to the email, never a blank', () => {
    const saved = auth.user;
    auth.user = { id: 'u2', email: 'investor@motoparts.com', role: 'TEMP_INVESTOR' };
    try {
      renderIt();
      expect(trigger().textContent).toContain('investor@motoparts.com');
    } finally {
      auth.user = saved;
    }
  });
});
