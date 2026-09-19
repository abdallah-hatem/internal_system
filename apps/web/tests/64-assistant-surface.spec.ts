/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: The assistant's token opens nothing but the assistant
 * ═══════════════════════════════════════════════════════════════════════
 *  BUSINESS_LOGIC §16: the assistant may not record or change sales, payments,
 *  instalments, settlements, returns or the ledger — "enforced by the system,
 *  not by the assistant's good behaviour". This is that enforcement, checked
 *  from outside: a real `mcp` token, signed with the API's own secret for a real
 *  core partner, sent to each of those routes, refused at the fence.
 *
 *  The token is minted here the way `AuthService.issueAssistantToken` mints it
 *  (HS256, audience `mcp`, subject the user id, one hour), because nothing in
 *  the API hands one out yet — the OAuth flow will. WRONG_SURFACE, not
 *  SESSION_INVALID, is what proves the signature was accepted: a token the API
 *  could not verify is refused earlier, with a 401.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { API, EMAIL, PASSWORD } from './support/fixtures';
import { apiSecret, sign } from './support/api-jwt';

/** The core partner's id, from the ordinary internal login. */
async function partnerId(request: APIRequestContext): Promise<string> {
  const res = await request.post(`${API}/auth/login`, {
    data: { email: EMAIL, password: PASSWORD },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.data.user.role).toBe('CORE_PARTNER');
  return body.data.user.id;
}

async function assistantToken(request: APIRequestContext): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return sign({ sub: await partnerId(request), aud: 'mcp', iat: now, exp: now + 3600 }, apiSecret());
}

/** Everything the assistant must never write, and the reads that sit beside it. */
const FORBIDDEN: Array<{ method: 'get' | 'post'; path: string; what: string }> = [
  { method: 'get', path: '/payments', what: 'payments' },
  { method: 'post', path: '/payments', what: 'recording a payment' },
  { method: 'post', path: '/sales/orders', what: 'creating a sale order' },
  { method: 'get', path: '/payment-plans', what: 'payment plans' },
  { method: 'post', path: '/payment-plans', what: 'creating a payment plan' },
  { method: 'get', path: '/returns', what: 'sale returns' },
  { method: 'post', path: '/returns', what: 'recording a sale return' },
  { method: 'get', path: '/settlements', what: 'settlements' },
  {
    method: 'post',
    path: '/settlements/00000000-0000-0000-0000-000000000000/approve',
    what: 'approving a settlement',
  },
  { method: 'get', path: '/ledger', what: 'the ledger' },
  { method: 'post', path: '/ledger', what: 'writing a ledger entry' },
];

test.describe('An assistant token on the office routes', () => {
  for (const [i, route] of FORBIDDEN.entries()) {
    const id = String(i + 1).padStart(2, '0');
    test(`TC-MCP-SURFACE-${id}: mcp token on ${route.method.toUpperCase()} ${route.path} (${route.what}) → 403 WRONG_SURFACE`, async ({
      request,
    }) => {
      const token = await assistantToken(request);
      // An empty body on the writes: the fence runs before validation, so the
      // refusal must be the surface, never a 400 about missing fields.
      const res = await request[route.method](`${API}${route.path}`, {
        headers: { Authorization: `Bearer ${token}` },
        ...(route.method === 'post' ? { data: {} } : {}),
      });
      expect(res.status()).toBe(403);
      expect((await res.json()).error.code).toBe('WRONG_SURFACE');
    });
  }

  test('TC-MCP-SURFACE-20: the same routes still open to the office token', async ({ request }) => {
    // The other direction. A fence that refused everybody would pass every test
    // above, and the office app would be down.
    const login = await request.post(`${API}/auth/login`, {
      data: { email: EMAIL, password: PASSWORD },
    });
    const token = (await login.json()).data.accessToken;
    for (const route of FORBIDDEN.filter((r) => r.method === 'get')) {
      const res = await request.get(`${API}${route.path}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status(), route.path).toBe(200);
    }
  });

  test('TC-MCP-SURFACE-21: an mcp token signed with the wrong secret is a stale session, not a wrong surface', async ({
    request,
  }) => {
    // Pins what WRONG_SURFACE above is evidence of: that the API accepted the
    // signature. If the test's secret were wrong, this is what every one of
    // those requests would have said instead.
    const now = Math.floor(Date.now() / 1000);
    const forged = sign(
      { sub: await partnerId(request), aud: 'mcp', iat: now, exp: now + 3600 },
      'not-the-secret-not-the-secret-not-the-secret',
    );
    const res = await request.get(`${API}/payments`, {
      headers: { Authorization: `Bearer ${forged}` },
    });
    expect(res.status()).toBe(401);
    expect((await res.json()).error.code).toBe('SESSION_INVALID');
  });
});
