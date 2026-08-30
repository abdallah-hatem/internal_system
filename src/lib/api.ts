import axios from 'axios';

/**
 * The one client that talks to the API.
 *
 * Only `/portal/*` and `/auth/portal/*` are reachable from here — the proxy in
 * front of the API publishes nothing else, and the API refuses an internal
 * route to a portal token anyway. If a call in this app ever 403s with
 * WRONG_SURFACE, it is asking for something the store is not allowed to see,
 * and the fix is on this side.
 */
export const api = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001/api/v1',
});

const TOKEN_KEY = 'storefront.token';

export const token = {
  get: () => (typeof window === 'undefined' ? null : localStorage.getItem(TOKEN_KEY)),
  set: (value: string) => localStorage.setItem(TOKEN_KEY, value),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

api.interceptors.request.use((config) => {
  const value = token.get();
  // Sent on public routes too: the catalogue reads it to decide whether to
  // quote trade prices, and a signed-in shop browsing anonymously would be
  // shown retail — which is the wrong number, not merely a missing feature.
  if (value) config.headers.Authorization = `Bearer ${value}`;
  return config;
});

api.interceptors.response.use(
  (r) => r,
  (error) => {
    // 401 means the session is finished. 403 does not — it means this account
    // may not do that particular thing, and signing out would lose the basket
    // over a refusal the person could have read and acted on.
    if (error.response?.status === 401 && typeof window !== 'undefined') {
      token.clear();
    }
    return Promise.reject(error);
  },
);
