import axios, { type InternalAxiosRequestConfig } from 'axios';
import { writeSessionCookie } from './session-cookie';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api/v1';

/**
 * Where Claude connects: the MCP endpoint sits at the API host's root, outside
 * `api/v1`, which is where MCP clients look for it.
 */
export const MCP_SERVER_URL = `${API_BASE.replace(/\/api\/v1\/?$/, '')}/mcp`;

export const api = axios.create({
  baseURL: API_BASE,
  headers: { 'Content-Type': 'application/json' },
});

/**
 * For the sign-in doors only: no interceptors, so a refused refresh can never
 * set off another refresh.
 */
export const authClient = axios.create({
  baseURL: API_BASE,
  headers: { 'Content-Type': 'application/json' },
});

/** Where the session lives in this browser. The cookie only mirrors `user`. */
export const TOKEN_KEY = 'token';
export const REFRESH_KEY = 'refreshToken';
export const USER_KEY = 'user';

/** Fired on window when a refresh brings a new token and user. */
export const SESSION_REFRESHED_EVENT = 'office-session-refreshed';

export interface StoredUser {
  id: string;
  email: string;
  role: string;
  displayName?: string | null;
  partner?: { displayName: string };
}

/** Keep a session: sign-in and every refresh come through here. */
export function storeSession(s: { accessToken: string; refreshToken?: string; user: StoredUser }) {
  localStorage.setItem(TOKEN_KEY, s.accessToken);
  if (s.refreshToken) localStorage.setItem(REFRESH_KEY, s.refreshToken);
  localStorage.setItem(USER_KEY, JSON.stringify(s.user));
  writeSessionCookie(s.user);
}

/** Forget the session in this browser. The server side is `revokeSession`. */
export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_KEY);
  localStorage.removeItem(USER_KEY);
  writeSessionCookie(null);
}

/**
 * End this sign-in on the server (logout). Best effort: the caller bounds it,
 * and a failure never keeps anybody signed in.
 */
export async function revokeSession() {
  const refreshToken = localStorage.getItem(REFRESH_KEY);
  if (!refreshToken) return;
  await authClient.post('/auth/logout', { refreshToken }).catch(() => undefined);
}

let refreshing: Promise<string | null> | null = null;

/**
 * Trade the refresh token for a new pair (owner, 2026-10-17: signed out every
 * time the app was opened, because the access token lasted a day and nothing
 * renewed it).
 *
 * Resolves to the new access token, or null when the sign-in is over (no
 * refresh token, or the API refused it). Rejects only when the API could not
 * be reached — then the session is kept, because a phone opened without
 * signal has not been signed out.
 *
 * One refresh at a time: every request that 401s while one is in flight waits
 * for it, in this tab, and across tabs through a Web Lock where the browser
 * has them. Two refreshes with the same token would look like theft to the
 * API, which ends the sign-in on every device.
 */
export function refreshSession(failedToken?: string | null): Promise<string | null> {
  if (!refreshing) {
    refreshing = refreshAcrossTabs(failedToken ?? null).finally(() => {
      refreshing = null;
    });
  }
  return refreshing;
}

async function refreshAcrossTabs(failedToken: string | null): Promise<string | null> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (locks?.request) {
    // The lock resolves with what the callback's promise resolves to; the DOM
    // typings call it a promise of a promise.
    const result: unknown = await locks.request('office-session-refresh', () => refreshOnce(failedToken));
    return result as string | null;
  }
  return refreshOnce(failedToken);
}

async function refreshOnce(failedToken: string | null): Promise<string | null> {
  // Another tab refreshed while this one waited for the lock: use its token.
  const current = localStorage.getItem(TOKEN_KEY);
  if (current && failedToken && current !== failedToken) return current;

  const presented = localStorage.getItem(REFRESH_KEY);
  if (!presented) return null;
  try {
    const res = await authClient.post('/auth/refresh', { refreshToken: presented });
    const next = res.data.data as { accessToken: string; refreshToken: string; user: StoredUser };
    storeSession(next);
    window.dispatchEvent(new CustomEvent(SESSION_REFRESHED_EVENT, { detail: next }));
    return next.accessToken;
  } catch (err) {
    const status = (err as { response?: { status?: number } }).response?.status;
    if (status === undefined) throw err;
    // A tab without Web Locks may have spent the same token a moment ago and
    // stored its successor; that one is good.
    const now = localStorage.getItem(REFRESH_KEY);
    if (now && now !== presented) return localStorage.getItem(TOKEN_KEY);
    return null;
  }
}

/** The doors that answer 401 for a wrong password, not an expired session. */
const SIGN_IN_DOORS = ['/auth/login', '/auth/refresh', '/auth/logout'];

type RetriableConfig = InternalAxiosRequestConfig & { _refreshed?: boolean };

function bearerOf(config: InternalAxiosRequestConfig): string | null {
  const header = config.headers?.Authorization;
  return typeof header === 'string' ? header.replace(/^Bearer /, '') : null;
}

function goToLogin() {
  // Keep the locale the user is actually in. This was hardcoded to
  // /en/login, and because a signed-out page fires queries that 401, this
  // hard navigation overrode the route guard's correct destination — an
  // Arabic session was thrown to the English login page no matter what the
  // guard did.
  const [, maybeLocale] = window.location.pathname.split('/');
  const locale = ['en', 'ar'].includes(maybeLocale) ? maybeLocale : 'en';
  const target = `/${locale}/login`;

  // Already there: replacing again would loop while the queries settle.
  if (window.location.pathname !== target) {
    window.location.replace(target);
  }
}

// Request interceptor: attach token
api.interceptors.request.use((config) => {
  if (typeof window !== 'undefined') {
    const token = localStorage.getItem(TOKEN_KEY);
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
  }
  return config;
});

// Response interceptor: on 401, refresh once and retry; sign out only when
// the sign-in itself is over.
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const config = error.config as RetriableConfig | undefined;
    if (error.response?.status !== 401 || typeof window === 'undefined') {
      return Promise.reject(error);
    }
    const door = SIGN_IN_DOORS.some((d) => config?.url?.startsWith(d));

    if (config && !door && !config._refreshed) {
      config._refreshed = true;
      let token: string | null;
      try {
        token = await refreshSession(bearerOf(config));
      } catch {
        // Unreachable, not refused: keep the session and report the failure.
        return Promise.reject(error);
      }
      if (token) {
        config.headers.Authorization = `Bearer ${token}`;
        return api(config);
      }
    }

    clearSession();
    goToLogin();
    return Promise.reject(error);
  }
);

// Auth API
export const authApi = {
  login: (email: string, password: string) =>
    api.post('/auth/login', { email, password }),
  register: (data: { email: string; password: string; displayName: string; role: string }) =>
    api.post('/auth/register', data),
  getProfile: () => api.get('/auth/profile'),
};

// Generic CRUD helpers
export const createCrudApi = <T>(endpoint: string) => ({
  list: (params?: Record<string, any>) => api.get(`/${endpoint}`, { params }),
  getById: (id: string) => api.get(`/${endpoint}/${id}`),
  create: (data: Partial<T>) => api.post(`/${endpoint}`, data),
  update: (id: string, data: Partial<T>) => api.put(`/${endpoint}/${id}`, data),
  delete: (id: string) => api.delete(`/${endpoint}/${id}`),
});
