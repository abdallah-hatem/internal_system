'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useSyncExternalStore } from 'react';

import { api, token } from './api';

/**
 * Who is holding the phone, and the three acts that change the answer.
 *
 * The token lives in `localStorage` under the one key `lib/api.ts` owns; this
 * never spells that key again. A second copy of it is how a sign-out clears one
 * store and the axios interceptor keeps reading the other.
 *
 * The server cannot see `localStorage`, so every screen that depends on the
 * session renders signed-out on the server and corrects itself on hydration.
 * `useSyncExternalStore` with a server snapshot of `null` is how that happens
 * without React shouting about mismatched HTML — reading the value straight in
 * a render would produce markup the server could never have written.
 */

const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  // Another tab signing out is this tab signing out. `storage` fires only in
  // the *other* tabs, which is why the local set exists as well.
  window.addEventListener('storage', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', listener);
  };
}

/**
 * The session also ends without anyone pressing anything.
 *
 * `lib/api.ts` clears the token on a 401, because a lapsed session is finished
 * whatever the caller was doing. That clearing is invisible to a hook watching
 * the store, so the screen would go on showing a signed-in shell over an API
 * that refuses everything. This interceptor adds no policy of its own — it is
 * registered after that one, so the token is already gone by the time it runs,
 * and all it does is say so.
 */
if (typeof window !== 'undefined') {
  api.interceptors.response.use(
    (r) => r,
    (error) => {
      if (error?.response?.status === 401) emit();
      return Promise.reject(error);
    },
  );
}

/** Has the browser taken over from the server's markup yet? */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
}

export type Session = {
  /** Null on the server and until hydration, whoever is signed in. */
  token: string | null;
  signedIn: boolean;
  /** False while the server's answer is still on screen. Do not decide on it. */
  ready: boolean;
};

export function useSession(): Session {
  const value = useSyncExternalStore(
    subscribe,
    () => token.get(),
    () => null,
  );
  const ready = useHydrated();

  return { token: value, signedIn: Boolean(value), ready };
}

export type PortalUser = {
  id: string;
  email: string;
  customerId: string;
  displayName: string;
  verified: boolean;
};

export type LoginResult = { accessToken: string; user: PortalUser };

export type SignUpResult = { customerId: string; displayName: string; verified: boolean };

export type Me = {
  id: string;
  displayName: string;
  phone: string | null;
  email: string | null;
  verified: boolean;
  /** Null when push is not configured. Then alerts are not offered at all. */
  pushPublicKey: string | null;
};

export const sessionKeys = {
  me: ['portal-me'] as const,
};

/**
 * Sign in.
 *
 * The password reaches exactly one place — the body of this request. Not a
 * query string, not the store, not a log line, and not the mutation's cached
 * variables afterwards, which is why `reset()` is called on success.
 */
export function useSignIn() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: async (credentials: { email: string; password: string }) => {
      const res = await api.post<{ data: LoginResult }>('/auth/portal/login', credentials);
      return res.data.data;
    },
    onSuccess: (result) => {
      token.set(result.accessToken);
      // Everything cached until now was quoted to nobody — retail prices, an
      // empty order list. Keeping it would show this shop the previous
      // visitor's view of the catalogue until each query happened to refetch.
      client.clear();
      emit();
    },
  });
}

/**
 * Sign up.
 *
 * The API returns no token on purpose, so neither does this. An account that
 * has not been looked at by a person is not a session, and quietly signing them
 * in would have the store behaving as though the review had already happened.
 */
export function useSignUp() {
  return useMutation({
    mutationFn: async (details: {
      email: string;
      password: string;
      shopName: string;
      phone?: string;
    }) => {
      const res = await api.post<{ data: SignUpResult }>('/auth/portal/signup', details);
      return res.data.data;
    },
  });
}

export function useSignOut() {
  const client = useQueryClient();

  return useCallback(() => {
    token.clear();
    // Not merely invalidated. An invalidated query keeps its data on screen
    // while it refetches, so this shop's orders would still be readable — now
    // by whoever picked the phone up next.
    client.clear();
    emit();
  }, [client]);
}

export function useMe() {
  const { signedIn, ready } = useSession();

  return useQuery({
    queryKey: sessionKeys.me,
    queryFn: async () => {
      const res = await api.get<{ data: Me }>('/portal/me');
      return res.data.data;
    },
    enabled: ready && signedIn,
    // Whether a shop has been verified decides what it can do, and it changes
    // in the office rather than here. Cheap to re-ask when the tab comes back.
    staleTime: 30_000,
  });
}
