import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/locales/en.json';
import LoginPage from './page';

/**
 * Typing before the page hydrates (2026-10-20). The fields were controlled
 * by state, so hydration reset what had been typed and the form went out
 * blank — "not valid: email, password". Seen on a slow machine in 60 e2e
 * logins; a person on a slow phone types just as early.
 */

const login = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const push = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/auth-context', () => ({ useAuth: () => ({ login }) }));
vi.mock('../../../i18n/navigation', () => ({ useRouter: () => ({ push }) }));

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  login.mockClear();
  push.mockClear();
});

const page = () => (
  <NextIntlClientProvider locale="en" messages={en} timeZone="Africa/Cairo">
    <LoginPage />
  </NextIntlClientProvider>
);

describe('the office login before and after hydration', () => {
  it('the server draws the Login button disabled, so no click can send the empty native form', () => {
    const html = renderToString(page());
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled/);
  });

  it('hydrated over the server HTML, what was typed before is kept and sent', async () => {
    const host = document.createElement('div');
    host.innerHTML = renderToString(page());
    document.body.appendChild(host);
    // Typed into the server's fields before React takes them over.
    (host.querySelector('input[type="email"]') as HTMLInputElement).value = 'abdallah@motoparts.com';
    (host.querySelector('input[type="password"]') as HTMLInputElement).value = 'password123';

    const { hydrateRoot } = await import('react-dom/client');
    const { act } = await import('react');
    await act(async () => {
      hydrateRoot(host, page());
    });

    const button = host.querySelector('button[type="submit"]') as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    expect((host.querySelector('input[type="email"]') as HTMLInputElement).value).toBe('abdallah@motoparts.com');
    await act(async () => {
      fireEvent.click(button);
    });
    expect(login).toHaveBeenCalledWith('abdallah@motoparts.com', 'password123');
  });

  it('typed after hydration, the same: the values in the fields are what is sent', async () => {
    render(page());
    fireEvent.change(screen.getByPlaceholderText('name@company.com'), { target: { value: 'shady@motoparts.com' } });
    fireEvent.change(screen.getByPlaceholderText('StrongPassword@123'), { target: { value: 'pw-123456' } });
    fireEvent.click(screen.getByRole('button', { name: en.auth.login }));
    await waitFor(() => expect(login).toHaveBeenCalledWith('shady@motoparts.com', 'pw-123456'));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/dashboard'));
  });
});
