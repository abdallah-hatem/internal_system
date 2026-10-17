'use client';

import { createContext, useContext, useState, useEffect, useCallback, useRef, ReactNode } from 'react';
import { useLocale } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import {
  api,
  authApi,
  clearSession,
  revokeSession,
  storeSession,
  SESSION_REFRESHED_EVENT,
  TOKEN_KEY,
  USER_KEY,
} from './api';
import { pushSupported } from './push';
import { useCycleWizardDraft } from '../stores/cycle-wizard-draft';
import { encodeSessionUser, readSessionCookie, writeSessionCookie, type SessionUser } from './session-cookie';

interface User {
  id: string;
  email: string;
  role: string;
  /** What POST /auth/login returns: the partner's name, flat on the user. */
  displayName?: string | null;
  /** The shape GET /auth/profile nests it in; read as a fallback. */
  partner?: { displayName: string };
}

interface AuthContextType {
  user: User | null;
  token: string | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  isLoading: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

/** How long sign-out waits for the server calls before going anyway. */
const PUSH_RELEASE_MS = 2000;

/**
 * Stop this browser receiving the signed-out partner's alerts.
 *
 * The subscription is stored against the user on the API, so without this the
 * next person to use the browser would go on getting the last one's
 * notifications. Best effort and bounded: a slow or failed request must not
 * keep anybody signed in. Guess, recorded in BUSINESS_LOGIC §19.
 */
async function releasePush() {
  if (!pushSupported()) return;
  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return;
  await api
    .delete('/notifications/push-subscriptions', { data: { endpoint: subscription.endpoint } })
    .catch(() => undefined);
  await subscription.unsubscribe().catch(() => false);
}

function readStoredSession(): { token: string; user: User } | null {
  const savedToken = localStorage.getItem(TOKEN_KEY);
  const savedUser = localStorage.getItem(USER_KEY);
  if (!savedToken || !savedUser) return null;
  try {
    return { token: savedToken, user: JSON.parse(savedUser) };
  } catch {
    return null;
  }
}

export function AuthProvider({
  children,
  initialUser = null,
}: {
  children: ReactNode;
  /**
   * Who the server read from the session cookie (lib/session-cookie.ts), so
   * the first paint is already the signed-in screen. Null when the cookie is
   * absent, and then the screen waits for storage as before.
   */
  initialUser?: SessionUser | null;
}) {
  const [user, setUser] = useState<User | null>(initialUser);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(!initialUser);
  const locale = useLocale();
  const queryClient = useQueryClient();
  const signingOut = useRef(false);

  useEffect(() => {
    // Storage is the session; the cookie only mirrors it for the server.
    // Bring the cookie in line (a session from before the cookie existed, a
    // sign-out in another tab, a token the API rejected), then trust storage.
    const saved = readStoredSession();
    if (saved) {
      setToken(saved.token);
      setUser(saved.user);
      if (readSessionCookie() !== encodeSessionUser(saved.user)) writeSessionCookie(saved.user);
    } else {
      setUser(null);
      if (readSessionCookie()) writeSessionCookie(null);
    }
    setIsLoading(false);

    // A page the back button restores from the back/forward cache comes back
    // with its memory intact — the signed-out user included — and no effect
    // runs again. Read storage afresh so a signed-out tab is not one press of
    // Back away from the last partner's screens. The same for a sign-out in
    // another tab of this browser.
    const resync = () => {
      const now = readStoredSession();
      if (!now) {
        writeSessionCookie(null);
        queryClient.clear();
        setToken(null);
        setUser(null);
      }
    };
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) resync();
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === TOKEN_KEY || e.key === null) resync();
    };
    // lib/api.ts renewed the session behind a request: hold the new token, and
    // the user as the API now describes them (a changed role or name).
    const onRefreshed = (e: Event) => {
      const next = (e as CustomEvent<{ accessToken: string; user: User }>).detail;
      setToken(next.accessToken);
      setUser(next.user);
    };
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('storage', onStorage);
    window.addEventListener(SESSION_REFRESHED_EVENT, onRefreshed);
    return () => {
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(SESSION_REFRESHED_EVENT, onRefreshed);
    };
  }, [queryClient]);

  const login = useCallback(async (email: string, password: string) => {
    const res = await authApi.login(email, password);
    const { accessToken, refreshToken, user: userData } = res.data.data;
    // Whatever the last session left in the cache is not this person's.
    queryClient.clear();
    storeSession({ accessToken, refreshToken, user: userData });
    setToken(accessToken);
    setUser(userData);
  }, [queryClient]);

  /**
   * Sign out of this browser (owner, 2026-10-14).
   *
   * The sign-in is ended on the server too (2026-10-17): the refresh token is
   * revoked, so a copy of it taken from this browser stops working. The access
   * token is a signed JWT and cannot be taken back; it lapses within the hour
   * (BUSINESS_LOGIC §23). Then what this browser remembers is cleared — the
   * cached data, the tokens and user, the unsaved cycle draft, the push
   * subscription.
   *
   * Lands on the login page of the language being read (it was hard-coded to
   * /en/login), and replaces the history entry so Back does not return to the
   * page just left.
   */
  const logout = useCallback(async () => {
    const target = `/${locale}/login`;
    if (signingOut.current) {
      window.location.replace(target);
      return;
    }
    signingOut.current = true;
    try {
      // While the tokens are still there to authorise them.
      await Promise.race([
        Promise.all([releasePush().catch(() => undefined), revokeSession()]),
        new Promise((resolve) => setTimeout(resolve, PUSH_RELEASE_MS)),
      ]);

      await queryClient.cancelQueries();
      queryClient.clear();

      clearSession();
      // A half-built cycle belongs to whoever typed it; the next partner on
      // this browser should not be offered it as theirs.
      useCycleWizardDraft.getState().clear();
      useCycleWizardDraft.persist.clearStorage();

      setToken(null);
      setUser(null);
    } finally {
      // A full load as well as the clears above: nothing held in memory by any
      // component survives it.
      window.location.replace(target);
    }
  }, [locale, queryClient]);

  return (
    <AuthContext.Provider value={{ user, token, login, logout, isLoading }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
}
