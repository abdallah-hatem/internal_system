import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEffect } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/i18n/locales/en.json';
import ar from '@/i18n/locales/ar.json';
import { AuthProvider, useAuth } from './auth-context';
import { revokeSession, SESSION_REFRESHED_EVENT } from './api';

vi.mock('./api', async (importOriginal) => {
  const real = await importOriginal<typeof import('./api')>();
  return {
    ...real,
    authApi: { login: vi.fn() },
    api: { delete: vi.fn(() => Promise.resolve({})) },
    revokeSession: vi.fn(() => Promise.resolve()),
  };
});

/**
 * Signing out (owner, 2026-10-14). The old logout() hard-coded /en/login, so
 * an Arabic reader was thrown into English, and it left the query cache alone —
 * on a client-side route the next partner to sign in on that browser would be
 * shown the previous one's figures until they refetched.
 */
let replace: ReturnType<typeof vi.fn>;
const realLocation = window.location;

beforeEach(() => {
  replace = vi.fn();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...realLocation, pathname: '/ar/dashboard', replace, href: 'http://x/ar/dashboard' },
  });
  localStorage.clear();
  localStorage.setItem('token', 'partner-a-token');
  localStorage.setItem('refreshToken', 'partner-a-refresh');
  localStorage.setItem('user', JSON.stringify({ id: 'a', email: 'a@x.y', role: 'CORE_PARTNER' }));
  localStorage.setItem('cycle-wizard-draft', JSON.stringify({ state: { draft: { currentStep: 2 } } }));
});

afterEach(() => {
  cleanup();
  Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
});

const seen: { current: ReturnType<typeof useAuth> | null } = { current: null };
function Capture() {
  const auth = useAuth();
  useEffect(() => {
    seen.current = auth;
  });
  return null;
}

function renderWith(locale: 'en' | 'ar', client: QueryClient) {
  render(
    <NextIntlClientProvider locale={locale} messages={locale === 'ar' ? ar : en} timeZone="Africa/Cairo">
      <QueryClientProvider client={client}>
        <AuthProvider>
          <Capture />
        </AuthProvider>
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

describe('logout()', () => {
  it('empties the query cache, so the next partner sees none of the last one’s data', async () => {
    const client = new QueryClient();
    client.setQueryData(['analytics', 'dashboard'], { totalRevenue: 987654 });
    renderWith('ar', client);
    expect(client.getQueryCache().getAll()).toHaveLength(1);

    await act(async () => {
      await seen.current!.logout();
    });

    expect(client.getQueryCache().getAll()).toHaveLength(0);
    expect(client.getQueryData(['analytics', 'dashboard'])).toBeUndefined();
  });

  it('goes to the login page of the locale being read, replacing the history entry', async () => {
    renderWith('ar', new QueryClient());
    await act(async () => {
      await seen.current!.logout();
    });
    expect(replace).toHaveBeenCalledWith('/ar/login');
  });

  it('and to /en/login for an English reader', async () => {
    renderWith('en', new QueryClient());
    await act(async () => {
      await seen.current!.logout();
    });
    expect(replace).toHaveBeenCalledWith('/en/login');
  });

  it('forgets the token, the user and the unsaved cycle draft on this browser', async () => {
    renderWith('en', new QueryClient());
    expect(seen.current!.user?.email).toBe('a@x.y');

    await act(async () => {
      await seen.current!.logout();
    });

    expect(localStorage.getItem('token')).toBeNull();
    expect(localStorage.getItem('user')).toBeNull();
    expect(localStorage.getItem('cycle-wizard-draft')).toBeNull();
    expect(seen.current!.user).toBeNull();
    expect(seen.current!.token).toBeNull();
  });

  it('ends the sign-in on the server while the refresh token is still there, then forgets it (2026-10-17)', async () => {
    let heldAtRevoke: string | null = 'unset';
    vi.mocked(revokeSession).mockImplementationOnce(async () => {
      heldAtRevoke = localStorage.getItem('refreshToken');
    });
    renderWith('en', new QueryClient());

    await act(async () => {
      await seen.current!.logout();
    });

    expect(revokeSession).toHaveBeenCalled();
    expect(heldAtRevoke).toBe('partner-a-refresh');
    expect(localStorage.getItem('refreshToken')).toBeNull();
  });

  it('a revoke that never answers does not keep anybody signed in', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(revokeSession).mockImplementationOnce(() => new Promise(() => {}));
    renderWith('en', new QueryClient());

    await act(async () => {
      const out = seen.current!.logout();
      await vi.advanceTimersByTimeAsync(2500);
      await out;
    });

    expect(localStorage.getItem('refreshToken')).toBeNull();
    expect(replace).toHaveBeenLastCalledWith('/en/login');
    vi.useRealTimers();
  });

  it('follows a refresh made behind a request: new token, user as the API now has them', async () => {
    renderWith('en', new QueryClient());
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(SESSION_REFRESHED_EVENT, {
          detail: { accessToken: 'fresh', user: { id: 'a', email: 'a@x.y', role: 'ADMIN_SUPPORT' } },
        }),
      );
    });
    expect(seen.current!.token).toBe('fresh');
    expect(seen.current!.user?.role).toBe('ADMIN_SUPPORT');
  });

  it('signing out twice does not throw and still lands on the login page', async () => {
    renderWith('en', new QueryClient());
    await act(async () => {
      await seen.current!.logout();
      await seen.current!.logout();
    });
    expect(replace).toHaveBeenLastCalledWith('/en/login');
  });

  it('a tab restored from the back/forward cache after sign-out drops the user it remembered', async () => {
    renderWith('en', new QueryClient());
    expect(seen.current!.user).not.toBeNull();

    // Another tab, or this one before the bfcache froze it, signed out.
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    await act(async () => {
      const ev = new Event('pageshow') as Event & { persisted?: boolean };
      Object.defineProperty(ev, 'persisted', { value: true });
      window.dispatchEvent(ev);
    });

    expect(seen.current!.user).toBeNull();
  });
});
