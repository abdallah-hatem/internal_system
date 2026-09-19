/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: /mcp — the assistant's door, over HTTP
 * ═══════════════════════════════════════════════════════════════════════
 *  Spec docs/specs/2026-09-19-mcp-assistant.md, "Endpoints" and "How it fits".
 *  BUSINESS_LOGIC §16: core partners only; access valid nowhere but here.
 *
 *  What a Claude client sees at the HTTP level: the sign-in challenge it needs
 *  to start OAuth, who is turned away, and a stateless server that answers each
 *  request on its own. The confirmation pattern itself is covered by the API's
 *  jest suite (confirmation.spec.ts), which drives it through a real MCP client;
 *  no production write tool exists at this layer yet to drive it end to end.
 *
 *  `/mcp` sits outside the `api/v1` prefix, where MCP clients look for it.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { API, apiCtx } from './support/fixtures';
import { apiSecret, sign } from './support/api-jwt';
import { assistantToken, mcpTokenFor, partnerId } from './support/assistant-token';

const ROOT = API.replace(/\/api\/v1\/?$/, '');
const MCP = `${ROOT}/mcp`;

const CHALLENGE = /^Bearer resource_metadata="https?:\/\/[^"]+\/\.well-known\/oauth-protected-resource"$/;

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'e2e', version: '1.0.0' },
  },
};

function post(request: APIRequestContext, body: object, token?: string) {
  return request.post(MCP, {
    headers: {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    data: body,
  });
}

test.describe('Signing in to /mcp', () => {
  test('TC-MCP-EP-01: no token → 401 with the resource-metadata header', async ({ request }) => {
    const res = await post(request, INITIALIZE);

    expect(res.status()).toBe(401);
    expect(res.headers()['www-authenticate']).toMatch(CHALLENGE);
    expect((await res.json()).error.code).toBe('AUTH_REQUIRED');
  });

  test('TC-MCP-EP-02: the challenge names the metadata document on this same API', async ({ request }) => {
    // The header is what claude.ai follows to find where to sign in. Pointing it
    // at another host would hand the sign-in to whoever runs that host.
    const res = await post(request, INITIALIZE);
    const url = /resource_metadata="([^"]+)"/.exec(res.headers()['www-authenticate'] ?? '')?.[1];

    expect(url).toBe(`${ROOT}/.well-known/oauth-protected-resource`);
  });

  test('TC-MCP-EP-03: a token signed with the wrong secret → 401 SESSION_INVALID with the challenge', async ({
    request,
  }) => {
    const forged = mcpTokenFor(await partnerId(request), 'not-the-secret-not-the-secret-not-the-secret');

    const res = await post(request, INITIALIZE, forged);

    expect(res.status()).toBe(401);
    expect(res.headers()['www-authenticate']).toMatch(CHALLENGE);
    expect((await res.json()).error.code).toBe('SESSION_INVALID');
  });

  test('TC-MCP-EP-04: an expired mcp token → 401, so the client refreshes', async ({ request }) => {
    const now = Math.floor(Date.now() / 1000);
    const expired = sign({ sub: await partnerId(request), aud: 'mcp', iat: now - 7200, exp: now - 3600 }, apiSecret());

    const res = await post(request, INITIALIZE, expired);

    expect(res.status()).toBe(401);
    expect(res.headers()['www-authenticate']).toMatch(CHALLENGE);
  });

  test("TC-MCP-EP-05: the office app's own token → 403 WRONG_SURFACE, no challenge", async ({ request }) => {
    const { headers } = await apiCtx(request);

    const res = await request.post(MCP, {
      headers: { ...headers, Accept: 'application/json, text/event-stream' },
      data: INITIALIZE,
    });

    expect(res.status()).toBe(403);
    expect((await res.json()).error.code).toBe('WRONG_SURFACE');
    expect(res.headers()['www-authenticate']).toBeUndefined();
  });

  test('TC-MCP-EP-06: a temporary investor with a genuine mcp token → 403 ASSISTANT_PARTNERS_ONLY', async ({
    request,
  }) => {
    const { headers } = await apiCtx(request);
    const list = await (await request.get(`${API}/users`, { headers })).json();
    const users: Array<{ id: string; role: string; status: string }> = list.data?.items ?? list.data ?? list;
    const investor = users.find((u) => u.role === 'TEMP_INVESTOR' && u.status === 'ACTIVE');
    expect(investor, 'the reference seed has a temporary investor').toBeTruthy();

    const res = await post(request, INITIALIZE, mcpTokenFor(investor!.id));

    expect(res.status()).toBe(403);
    expect((await res.json()).error.code).toBe('ASSISTANT_PARTNERS_ONLY');
  });

  test('TC-MCP-EP-07: a confirmation token presented as an access token → 403 WRONG_SURFACE', async ({ request }) => {
    // Confirmation tokens are signed with the same secret. Their own audience is
    // what keeps a preview's token from opening the door.
    const now = Math.floor(Date.now() / 1000);
    const confirmation = sign(
      {
        sub: await partnerId(request),
        aud: 'mcp-confirmation',
        tool: 'create_purchase_order',
        input: 'x',
        jti: 'e2e-not-a-real-jti',
        iat: now,
        exp: now + 900,
      },
      apiSecret(),
    );

    const res = await post(request, INITIALIZE, confirmation);

    expect(res.status()).toBe(403);
    expect((await res.json()).error.code).toBe('WRONG_SURFACE');
  });
});

test.describe('A core partner on /mcp', () => {
  test('TC-MCP-EP-10: initialize → the MotoParts server, stateless, with the receipt workflow', async ({ request }) => {
    const res = await post(request, INITIALIZE, await assistantToken(request));

    expect(res.status()).toBe(200);
    expect(res.headers()['mcp-session-id']).toBeUndefined();
    const body = await res.json();
    expect(body.result.serverInfo.name).toBe('motoparts');
    expect(body.result.instructions).toContain('match_receipt');
    expect(body.result.instructions).toContain('confirmationToken');
  });

  test('TC-MCP-EP-11: a request with no initialize before it is answered — nothing is kept between requests', async ({
    request,
  }) => {
    // On serverless the next request may land on another instance. A server
    // that needed the earlier handshake in memory would fail here.
    const res = await request.post(MCP, {
      headers: {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        'Mcp-Protocol-Version': '2025-06-18',
        Authorization: `Bearer ${await assistantToken(request)}`,
      },
      data: { jsonrpc: '2.0', id: 7, method: 'ping' },
    });

    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ jsonrpc: '2.0', id: 7, result: {} });
  });

  test('TC-MCP-EP-12: a body that is not JSON-RPC → a 4xx JSON-RPC error, never a 500', async ({ request }) => {
    const res = await post(request, { hello: 'world' }, await assistantToken(request));

    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(res.status()).toBeLessThan(500);
    expect((await res.json()).error).toBeDefined();
  });

  test('TC-MCP-EP-13: GET → 405, a stateless server has no event stream to hold open', async ({ request }) => {
    const res = await request.get(MCP, {
      headers: {
        Accept: 'text/event-stream',
        Authorization: `Bearer ${await assistantToken(request)}`,
      },
    });

    expect(res.status()).toBe(405);
    expect(res.headers()['allow']).toBe('POST, DELETE');
  });

  test('TC-MCP-EP-14: the mcp token is still refused on the office API beside it', async ({ request }) => {
    // The other direction of the fence, from this suite's side: the token that
    // just opened /mcp opens nothing under /api/v1.
    const res = await request.get(`${API}/cycles`, {
      headers: { Authorization: `Bearer ${await assistantToken(request)}` },
    });

    expect(res.status()).toBe(403);
    expect((await res.json()).error.code).toBe('WRONG_SURFACE');
  });
});
