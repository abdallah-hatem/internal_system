import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { api, authClient, REFRESH_KEY, SESSION_REFRESHED_EVENT, TOKEN_KEY, USER_KEY } from './api';
import { readSessionCookie } from './session-cookie';

/**
 * Staying signed in (owner, 2026-10-17: "why do I have to log in every time I
 * open it"). A request that 401s refreshes the session once and is retried;
 * only a refused refresh signs the partner out.
 *
 * Both axios instances get a fake adapter, so what is tested is the real
 * interceptor chain: the request as sent, the 401, the refresh, the retry.
 */

type Config = InternalAxiosRequestConfig;
const USER = { id: 'u1', email: 'p@x.y', role: 'CORE_PARTNER', displayName: 'Partner' };

function reply(config: Config, status: number, data: unknown = {}): Promise<AxiosResponse> {
  const res = { data, status, statusText: '', headers: {}, config } as AxiosResponse;
  return status < 400 ? Promise.resolve(res) : Promise.reject(new AxiosError('refused', undefined, config, null, res));
}
const offline = (config: Config) => Promise.reject(new AxiosError('Network Error', 'ERR_NETWORK', config));

/** Calls each adapter saw: method, url, and the bearer it carried. */
let sent: { url: string; bearer?: string; body?: unknown }[];
let refreshes: number;
let replace: ReturnType<typeof vi.fn>;
const realLocation = window.location;

/** The API: `good-*` tokens pass, anything else 401s. */
function office(config: Config) {
  const bearer = String(config.headers?.Authorization ?? '').replace('Bearer ', '');
  sent.push({ url: config.url!, bearer });
  return bearer.startsWith('good') ? reply(config, 200, { ok: config.url }) : reply(config, 401);
}

function refreshWith(answer: (config: Config) => Promise<AxiosResponse>) {
  authClient.defaults.adapter = async (config) => {
    sent.push({ url: config.url!, body: JSON.parse(String(config.data)) });
    if (config.url === '/auth/refresh') refreshes++;
    // Let the event loop run, so concurrent 401s really overlap the refresh.
    await new Promise((r) => setTimeout(r, 5));
    return answer(config);
  };
}

const grants = (config: Config) =>
  reply(config, 200, {
    data: { accessToken: 'good-2', refreshToken: 'refresh-2', user: { ...USER, role: 'ADMIN_SUPPORT' } },
  });

beforeEach(() => {
  sent = [];
  refreshes = 0;
  replace = vi.fn();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...realLocation, pathname: '/ar/dashboard', replace },
  });
  localStorage.clear();
  localStorage.setItem(TOKEN_KEY, 'expired-1');
  localStorage.setItem(REFRESH_KEY, 'refresh-1');
  localStorage.setItem(USER_KEY, JSON.stringify(USER));
  api.defaults.adapter = office;
  refreshWith(grants);
});

afterEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
  vi.unstubAllGlobals();
});

describe('a request whose access token expired', () => {
  it('refreshes once, retries with the new token, and the caller never sees the 401', async () => {
    const heard = vi.fn();
    window.addEventListener(SESSION_REFRESHED_EVENT, heard);

    const res = await api.get('/cycles');

    expect(res.data).toEqual({ ok: '/cycles' });
    expect(sent.map((s) => s.url)).toEqual(['/cycles', '/auth/refresh', '/cycles']);
    expect(sent[1].body).toEqual({ refreshToken: 'refresh-1' });
    expect(sent[2].bearer).toBe('good-2');
    // The new pair is kept, the user as the API now describes them…
    expect(localStorage.getItem(TOKEN_KEY)).toBe('good-2');
    expect(localStorage.getItem(REFRESH_KEY)).toBe('refresh-2');
    expect(JSON.parse(localStorage.getItem(USER_KEY)!).role).toBe('ADMIN_SUPPORT');
    // …the server's cookie follows, and the provider is told.
    expect(readSessionCookie()).toContain('ADMIN_SUPPORT');
    expect(heard).toHaveBeenCalledTimes(1);
    expect(replace).not.toHaveBeenCalled();
    window.removeEventListener(SESSION_REFRESHED_EVENT, heard);
  });

  it('opening the app fires many requests at once: they share one refresh', async () => {
    const results = await Promise.all([api.get('/a'), api.get('/b'), api.get('/c'), api.post('/d', {})]);

    expect(results.map((r) => r.data.ok)).toEqual(['/a', '/b', '/c', '/d']);
    // Two refreshes with one token would read as theft and end the sign-in.
    expect(refreshes).toBe(1);
  });

  it('a second wave after the first refresh does not refresh again', async () => {
    await api.get('/a');
    await api.get('/b');
    expect(refreshes).toBe(1);
  });
});

describe('when the sign-in itself is over', () => {
  it('a refused refresh signs out: storage, cookie, and to the login page in the reader’s language', async () => {
    refreshWith((config) => reply(config, 401, { error: { code: 'SESSION_EXPIRED' } }));

    await expect(api.get('/cycles')).rejects.toMatchObject({ response: { status: 401 } });

    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(localStorage.getItem(REFRESH_KEY)).toBeNull();
    expect(localStorage.getItem(USER_KEY)).toBeNull();
    expect(readSessionCookie()).toBeNull();
    expect(replace).toHaveBeenCalledWith('/ar/login');
  });

  it('a retried request that 401s again signs out, without refreshing in a loop', async () => {
    refreshWith((config) =>
      reply(config, 200, { data: { accessToken: 'still-bad', refreshToken: 'refresh-2', user: USER } }),
    );

    await expect(api.get('/cycles')).rejects.toMatchObject({ response: { status: 401 } });

    expect(refreshes).toBe(1);
    expect(sent.filter((s) => s.url === '/cycles')).toHaveLength(2);
    expect(replace).toHaveBeenCalledWith('/ar/login');
  });

  it('a session from before refresh tokens existed signs out without asking', async () => {
    localStorage.removeItem(REFRESH_KEY);

    await expect(api.get('/cycles')).rejects.toBeDefined();

    expect(refreshes).toBe(0);
    expect(replace).toHaveBeenCalledWith('/ar/login');
  });
});

describe('what must not refresh or sign out', () => {
  it('no signal: the refresh cannot reach the API, so the session is kept', async () => {
    refreshWith(offline);

    await expect(api.get('/cycles')).rejects.toBeDefined();

    expect(localStorage.getItem(REFRESH_KEY)).toBe('refresh-1');
    expect(localStorage.getItem(TOKEN_KEY)).toBe('expired-1');
    expect(replace).not.toHaveBeenCalled();
    // And the next request tries again once there is signal.
    refreshWith(grants);
    await expect(api.get('/cycles')).resolves.toBeDefined();
  });

  it('a wrong password on the login door is not an expired session', async () => {
    api.defaults.adapter = (config) => reply(config, 401, { error: { code: 'INVALID_CREDENTIALS' } });

    await expect(api.post('/auth/login', { email: 'a', password: 'b' })).rejects.toBeDefined();

    expect(refreshes).toBe(0);
  });

  it('another tab already refreshed: its token is used, the spent refresh token is not sent again', async () => {
    // This request went out with the old token; meanwhile another tab stored a new pair.
    api.defaults.adapter = (config) => {
      const bearer = String(config.headers?.Authorization ?? '').replace('Bearer ', '');
      sent.push({ url: config.url!, bearer });
      if (bearer === 'expired-1') {
        localStorage.setItem(TOKEN_KEY, 'good-from-other-tab');
        localStorage.setItem(REFRESH_KEY, 'refresh-from-other-tab');
        return reply(config, 401);
      }
      return office(config);
    };

    const res = await api.get('/cycles');

    expect(res.status).toBe(200);
    expect(refreshes).toBe(0);
    expect(sent.at(-1)?.bearer).toBe('good-from-other-tab');
  });

  it('a tab without Web Locks lost the race to another tab: it takes the winner’s pair, not the login page', async () => {
    // Both tabs sent refresh-1; the other tab won, stored its pair, and this
    // tab's copy of the spent token was refused.
    refreshWith((config) => {
      localStorage.setItem(TOKEN_KEY, 'good-from-other-tab');
      localStorage.setItem(REFRESH_KEY, 'refresh-from-other-tab');
      return reply(config, 401, { error: { code: 'SESSION_EXPIRED' } });
    });

    const res = await api.get('/cycles');

    expect(res.status).toBe(200);
    expect(sent.at(-1)?.bearer).toBe('good-from-other-tab');
    expect(replace).not.toHaveBeenCalled();
  });

  it('with Web Locks, the refresh runs inside the shared lock', async () => {
    const request = vi.fn((_name: string, fn: () => Promise<unknown>) => fn());
    vi.stubGlobal('navigator', { ...navigator, locks: { request } });

    await api.get('/cycles');

    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toBe('office-session-refresh');
  });
});
